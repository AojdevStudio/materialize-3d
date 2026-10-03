#!/usr/bin/env bash
# Installs a release DMG the way a new person meets it, on this Mac, and runs the CAD helper from the installed app:
#   scripts/release/clean-install-test-macos.sh <release.dmg>
#
# Creates a fresh standard account with no password (nobody can log in as it) and does the rest as that account,
# with an empty home and only the system PATH: the DMG lands in ~/Downloads with a quarantine attribute as a browser
# would set it, Gatekeeper assesses the DMG and the app, the app is copied into ~/Applications (a standard account
# cannot write /Applications), check-app-bundle.sh checks it, and the bundled helper, still quarantined, verifies
# its runtime, boots both guests, and builds the cable clip (cad-host/spike/cable-clip-fillet-first.py). Any failure
# fails the run. The account and its home are deleted on exit, and a teardown that leaves anything behind fails the
# run too; evidence, teardown.txt included, stays in ~/m3d-verify/clean-install-<run>/.
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

# One run per process: the PID keeps two runs that start in the same second apart.
run="$(date +%Y%m%dT%H%M%S)-$$"
evidence="$HOME/m3d-verify/clean-install-$run"
mkdir -p "$HOME/m3d-verify"
mkdir "$evidence" || die "$evidence already exists"
shared="/Users/Shared/m3d-clean-$run"

# Every lookup below answers present or absent, or fails: an error from dscl, sudo, or hdiutil never reads as
# "absent", so neither the reservation nor the teardown can mistake a failed check for a clean state.
# dscl reports a missing record as eDSRecordNotFound (exit 56); any other failure is a lookup error.
account_state() { # <name>
  local out rc=0
  out="$(dscl . -read "/Users/$1" RecordName 2>&1)" || rc=$?
  if (( rc == 0 )); then echo present; return 0; fi
  if (( rc == 56 )) && [[ "$out" == *eDSRecordNotFound* ]]; then echo absent; return 0; fi
  echo "clean-install: dscl . -read /Users/$1 failed (exit $rc): $out" >&2
  return 1
}

# Anything at the path counts as present, a dangling symlink included, as root sees it.
path_state() { # <path>
  local out
  out="$(sudo -n /bin/sh -c 'if [ -e "$1" ] || [ -L "$1" ]; then echo present; else echo absent; fi' sh "$1")" \
    || return 1
  [[ "$out" == present || "$out" == absent ]] || return 1
  echo "$out"
}

# The account that holds a UID, if any.
uid_owner() { # <uid>
  local list
  list="$(dscl . -list /Users UniqueID)" || return 1
  awk -v id="$1" '$2 == id { print $1 }' <<<"$list"
}

# Whether this run's DMG, or anything at its mount point, is still attached.
image_state() {
  local info
  info="$(sudo -n hdiutil info)" || return 1
  if [[ "$info" == *"$home/Downloads/Materialize-3D.dmg"* || "$info" == *"$home/mnt"* ]]; then
    echo present
  else
    echo absent
  fi
}

# Picks a name, home, and UID that nothing on this Mac uses, or stops the run.
reserve_account() {
  local state owner
  user="m3dclean$(date +%s)$$"
  home="/Users/$user"
  state="$(account_state "$user")" || die "could not look up account $user"
  [[ "$state" == absent ]] || die "an account named $user already exists"
  state="$(path_state "$home")" || die "could not check $home"
  [[ "$state" == absent ]] || die "something already exists at $home"
  uid=601
  while :; do
    owner="$(uid_owner "$uid")" || die "could not list the UIDs in use"
    [[ -z "$owner" ]] && break
    uid=$((uid + 1))
  done
  (( uid < 1000 )) || die "no free UID between 601 and 999"
}

# Teardown bookkeeping: each check's result goes to teardown.txt, and any check that did not pass fails the run.
failed=() teardown_log=()
step() { # <description> <command...>
  local what="$1" rc=0
  shift
  "$@" >/dev/null 2>&1 || rc=$?
  teardown_log+=("$what: exit $rc")
  (( rc == 0 )) || failed+=("$what (exit $rc)")
}
expect_absent() { # <description> <state command...>
  local what="$1" state rc=0
  shift
  state="$("$@")" || rc=$?
  if (( rc != 0 )); then
    teardown_log+=("$what: the check failed (exit $rc)")
    failed+=("$what: the check failed (exit $rc)")
  elif [[ "$state" != absent ]]; then
    teardown_log+=("$what: still $state")
    failed+=("$what: still $state")
  else
    teardown_log+=("$what: absent")
  fi
}

# Every teardown step runs, and only for what this run created. A teardown that leaves the account, its home, the
# staged files, or an attached image behind, or that cannot check one of them, fails the run, even one whose checks
# passed.
cleanup() {
  local rc=$? state check_rc
  if [[ "$created_account" == 1 ]]; then
    check_rc=0
    state="$(image_state)" || check_rc=$?
    if (( check_rc != 0 )); then
      teardown_log+=("this run's DMG attached: the check failed (exit $check_rc)")
      failed+=("this run's DMG attached: the check failed (exit $check_rc)")
    elif [[ "$state" == present ]]; then
      step "detach $home/mnt" sudo -n hdiutil detach "$home/mnt" -force
    fi
    expect_absent "this run's DMG attached" image_state
    check_rc=0
    state="$(path_state "$home/evidence")" || check_rc=$?
    if (( check_rc != 0 )); then
      failed+=("the account's evidence: the check failed (exit $check_rc)")
    elif [[ "$state" == present ]]; then
      step "copy the account's evidence" sudo -n cp -R "$home/evidence/." "$evidence/"
      step "hand the evidence to $(id -un)" sudo -n chown -R "$(id -u):$(id -g)" "$evidence"
    fi
    step "delete account $user" sudo -n dscl . -delete "/Users/$user"
    expect_absent "account $user" account_state "$user"
  fi
  if [[ "$created_home" == 1 ]]; then
    step "delete $home" sudo -n rm -rf "$home"
    expect_absent "$home" path_state "$home"
  fi
  if [[ "$created_shared" == 1 ]]; then
    step "delete $shared" sudo -n rm -rf "$shared"
    expect_absent "$shared" path_state "$shared"
  fi
  {
    echo "account $user (uid $uid) created by this run: $([[ "$created_account" == 1 ]] && echo yes || echo no)"
    echo "home $home created by this run: $([[ "$created_home" == 1 ]] && echo yes || echo no)"
    echo "staged files $shared created by this run: $([[ "$created_shared" == 1 ]] && echo yes || echo no)"
    if (( ${#teardown_log[@]} > 0 )); then printf 'check: %s\n' "${teardown_log[@]}"; fi
    if (( ${#failed[@]} > 0 )); then
      printf 'teardown FAILED: %s\n' "${failed[@]}"
    else
      echo "teardown complete: nothing this run created is left"
    fi
  } | tee "$evidence/teardown.txt"
  if (( ${#failed[@]} > 0 )) && [[ "$rc" == 0 ]]; then rc=1; fi
  exit "$rc"
}

created_account=0 created_home=0 created_shared=0
user="" home="" uid=""
trap cleanup EXIT
reserve_account

# What the account receives, readable by it: the DMG, the spike script, and the bundle check.
sudo -n mkdir "$shared" || die "could not create $shared"
created_shared=1
sudo -n cp "$dmg" "$shared/release.dmg"
sudo -n cp "$root/cad-host/spike/cable-clip-fillet-first.py" "$root/cad-host/spike/cable-clip.params.json" \
  "$root/scripts/release/check-app-bundle.sh" "$shared/"
sudo -n chmod -R a+rX "$shared"

echo "clean-install: creating standard account $user (uid $uid, staff, no password, not an admin)"
sudo -n dscl . -create "/Users/$user" || die "could not create account $user"
created_account=1
for field in "UserShell /bin/zsh" "RealName Materialize-3D-clean-install-test" "UniqueID $uid" \
  "PrimaryGroupID 20" "NFSHomeDirectory $home"; do
  # shellcheck disable=SC2086 # each entry is a key and its value
  sudo -n dscl . -create "/Users/$user" $field
done
sudo -n dscl . -create "/Users/$user" Password '*'
# reserve_account found nothing at $home, so whatever is there from here on is this run's.
created_home=1
sudo -n createhomedir -c -u "$user" >/dev/null
owner="$(uid_owner "$uid")" || die "could not list the UIDs in use"
[[ "$owner" == "$user" ]] || die "UID $uid is not this run's alone"
# dseditgroup exits 0 for a member and 67 for a non-member; anything else is a failed check.
admin_rc=0
dseditgroup -o checkmember -m "$user" admin >/dev/null 2>&1 || admin_rc=$?
(( admin_rc == 67 )) || die "$user is an admin, or the check failed (dseditgroup exit $admin_rc)"
# The account template may not create ~/Applications at all; either way nothing may be installed yet.
state="$(path_state "$home/Applications")" || die "could not check $home/Applications"
if [[ "$state" == present ]]; then
  listing="$(sudo -n ls -A "$home/Applications")" || die "could not list $home/Applications"
  [[ -z "$listing" ]] || die "$home/Applications is not empty"
fi

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
