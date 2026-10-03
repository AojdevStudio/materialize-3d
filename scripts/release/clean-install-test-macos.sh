#!/usr/bin/env bash
# Installs a release DMG the way a new person meets it, on this Mac, and runs the CAD helper from the installed app:
#   scripts/release/clean-install-test-macos.sh <release.dmg>
#
# Creates a fresh standard account with no password (nobody can log in as it) and does the rest as that account,
# with an empty home and only the system PATH: the DMG lands in ~/Downloads with a quarantine attribute as a browser
# would set it, Gatekeeper assesses the DMG and the app, the app is copied into ~/Applications (a standard account
# cannot write /Applications), check-app-bundle.sh checks it, and the bundled helper, still quarantined, verifies
# its runtime, boots both guests, and builds the cable clip (cad-host/spike/cable-clip-fillet-first.py). Any failure
# fails the run. The account and its home are deleted on exit; evidence stays in ~/m3d-verify/clean-install-<run>/.
#
# Needs Apple Silicon, macOS 26 or later, and sudo without a password prompt (to create and delete the account).
# What "clean" covers and what it does not is in docs/releasing.md.
set -euo pipefail
die() { echo "clean-install: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || { echo "usage: $0 <release.dmg>" >&2; exit 2; }
[[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]] || die "run on an Apple Silicon Mac"
(( "$(sw_vers -productVersion | cut -d. -f1)" >= 26 )) || die "the app needs macOS 26 or later"
sudo -n true 2>/dev/null || die "needs sudo without a password prompt to create the test account"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dmg="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[[ -f "$dmg" ]] || die "no DMG at $1"

run="$(date +%Y%m%dT%H%M%S)"
user="m3dclean$(date +%s)"
uid=$(( $(dscl . -list /Users UniqueID | awk '$2 >= 600 && $2 < 1000 { print $2 }' | sort -n | tail -1) + 1 ))
(( uid >= 601 )) || uid=601
evidence="$HOME/m3d-verify/clean-install-$run"
shared="/Users/Shared/m3d-clean-$run"
home="/Users/$user"
mkdir -p "$evidence"

cleanup() {
  sudo -n hdiutil detach "$home/mnt" -force >/dev/null 2>&1 || true
  if [[ -d "$home/evidence" ]]; then
    sudo -n cp -R "$home/evidence/." "$evidence/" && sudo -n chown -R "$(id -u):$(id -g)" "$evidence" || true
  fi
  sudo -n dscl . -delete "/Users/$user" >/dev/null 2>&1 || true
  sudo -n rm -rf "$home" "$shared"
  if dscl . -read "/Users/$user" >/dev/null 2>&1 || [[ -e "$home" ]]; then
    echo "clean-install: the test account $user was not fully removed" >&2
  else
    echo "clean-install: test account $user and its home deleted"
  fi
}
trap cleanup EXIT

# What the account receives, readable by it: the DMG, the spike script, and the bundle check.
sudo -n mkdir -p "$shared"
sudo -n cp "$dmg" "$shared/release.dmg"
sudo -n cp "$root/cad-host/spike/cable-clip-fillet-first.py" "$root/cad-host/spike/cable-clip.params.json" \
  "$root/scripts/release/check-app-bundle.sh" "$shared/"
sudo -n chmod -R a+rX "$shared"

echo "clean-install: creating standard account $user (uid $uid, staff, no password, not an admin)"
for field in "UserShell /bin/zsh" "RealName Materialize-3D-clean-install-test" "UniqueID $uid" \
  "PrimaryGroupID 20" "NFSHomeDirectory $home"; do
  # shellcheck disable=SC2086 # each entry is a key and its value
  sudo -n dscl . -create "/Users/$user" $field
done
sudo -n dscl . -create "/Users/$user" Password '*'
sudo -n createhomedir -c -u "$user" >/dev/null
dseditgroup -o checkmember -m "$user" admin >/dev/null 2>&1 && die "$user is an admin"
# The account template may not create ~/Applications at all; either way nothing may be installed yet.
[[ -z "$(sudo -n ls -A "$home/Applications" 2>/dev/null)" ]] || die "$home/Applications is not empty"

started="$(date '+%Y-%m-%d %H:%M:%S')"
set +e
sudo -n -u "$user" -H env -i HOME="$home" USER="$user" TMPDIR="$home/tmp" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  SHARED="$shared" /bin/bash -s <<'BODY' 2>&1 | tee "$evidence/actions.log"
set -euo pipefail
cd "$HOME"
mkdir -p Downloads Applications evidence tmp spike
log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { log "FAIL $*"; exit 1; }
log "account $(id -un) (uid $(id -u), groups $(id -Gn)), home $HOME, PATH $PATH"
log "macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)), $(sysctl -n machdep.cpu.brand_string)"

log "== download: the DMG lands in ~/Downloads with a browser's quarantine attribute"
dmg="$HOME/Downloads/Materialize-3D.dmg"
cp "$SHARED/release.dmg" "$dmg"
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$dmg"
log "dmg sha256 $(shasum -a 256 "$dmg" | cut -d' ' -f1), quarantine $(xattr -p com.apple.quarantine "$dmg")"
spctl --assess --type open --context context:primary-signature -vv "$dmg" > evidence/spctl-dmg.txt 2>&1 \
  || { cat evidence/spctl-dmg.txt; fail "Gatekeeper rejected the DMG"; }
cat evidence/spctl-dmg.txt
grep -q 'source=Notarized Developer ID' evidence/spctl-dmg.txt || fail "the DMG is not notarized Developer ID"

log "== open the DMG and copy the app to ~/Applications"
mkdir -p mnt
hdiutil attach -nobrowse -readonly -mountpoint "$HOME/mnt" "$dmg" >/dev/null
log "dmg contents: $(cd mnt && ls -A | tr '\n' ' ')"
app="$HOME/Applications/Materialize 3D.app"
ditto "mnt/Materialize 3D.app" "$app"
hdiutil detach "$HOME/mnt" >/dev/null
helper="$app/Contents/MacOS/materialize-cad-host"
quarantine="$(xattr -p com.apple.quarantine "$helper" 2>/dev/null || true)"
log "quarantine carried from the DMG to the installed helper: ${quarantine:-none}"
if [[ -z "$quarantine" ]]; then
  # A copy made outside Finder may drop it; mark every file the way a download would, so Gatekeeper still assesses.
  xattr -r -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$app"
  log "marked every file in the app with a quarantine attribute: $(xattr -p com.apple.quarantine "$helper")"
fi

log "== Gatekeeper on the installed, quarantined app"
spctl --assess --type execute -vv "$app" > evidence/spctl-app.txt 2>&1 \
  || { cat evidence/spctl-app.txt; fail "Gatekeeper rejected the app"; }
cat evidence/spctl-app.txt
grep -q 'source=Notarized Developer ID' evidence/spctl-app.txt || fail "the app is not notarized Developer ID"
syspolicy_check distribution "$app" > evidence/syspolicy-check.txt 2>&1 \
  || { cat evidence/syspolicy-check.txt; fail "syspolicy_check rejected the app"; }
tail -2 evidence/syspolicy-check.txt
team="$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
bash "$SHARED/check-app-bundle.sh" "$app" "$team"

log "== the bundled helper, still quarantined, verifies its runtime and builds the cable clip"
"$helper" verify --runtime "$app/Contents/Resources/cad-runtime" > evidence/helper-verify.json
cp "$SHARED/cable-clip-fillet-first.py" "$SHARED/cable-clip.params.json" spike/
started=$(date +%s)
"$helper" build --runtime "$app/Contents/Resources/cad-runtime" --source spike/cable-clip-fillet-first.py \
  --params spike/cable-clip.params.json --deadline-s 120 --out out/clip > /dev/null 2> evidence/helper-build.stderr \
  || { cat evidence/helper-build.stderr; cat out/clip/result.json 2>/dev/null; fail "the helper build failed"; }
log "build took $(( $(date +%s) - started )) s"
cp out/clip/result.json evidence/clip-result.json
facts="$(/usr/bin/jq -r '[.outcome, (.bodies | length), .bodies[0].mesh.closed_manifold,
  .bodies[0].mesh.non_degenerate, .bodies[0].mesh.outward, .bodies[0].mesh.triangles] | map(tostring) | join(" ")' \
  evidence/clip-result.json)"
log "result: outcome, bodies, closed, non-degenerate, outward, triangles = $facts"
read -r outcome bodies closed nondeg outward _ <<<"$facts"
[[ "$outcome $bodies $closed $nondeg $outward" == "accepted 1 true true true" ]] || fail "the clip is not a closed mesh"
log "quarantine on the helper after the run: $(xattr -p com.apple.quarantine "$helper" 2>/dev/null || echo none)"
log "done"
BODY
status=${PIPESTATUS[0]}
set -e
# Gatekeeper's own record of this run, for reading alongside the account's log.
sudo -n log show --start "$started" --style compact \
  --predicate 'process == "syspolicyd" AND eventMessage CONTAINS[c] "materialize"' > "$evidence/syspolicyd.log" 2>&1 || true
[[ "$status" == 0 ]] || die "failed; evidence in $evidence"
echo "clean-install: passed; evidence in $evidence"
