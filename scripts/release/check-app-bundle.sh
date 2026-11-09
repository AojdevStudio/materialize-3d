#!/usr/bin/env bash
# Checks a built or installed Materialize 3D app against what a release must hold:
#   scripts/release/check-app-bundle.sh <path to Materialize 3D.app> <team id>
# Exactly the allowlisted files and nothing else, macOS 26.0 as the minimum, and the sidecar arm64-only and signed
# by the team under the hardened runtime with the JIT entitlement and no other. build-macos.sh runs it on the
# stapled app and on the app inside the update archive.
set -euo pipefail
die() { echo "bundle: $*" >&2; exit 1; }
[[ $# -eq 2 ]] || { echo "usage: $0 <app> <team id>" >&2; exit 2; }
app="$1" team="$2"
[[ -f "$app/Contents/Info.plist" ]] || die "no app bundle at $app"

# The list below compares one path per line, so a newline inside a file or directory name could split one path
# into two lines that pass for two allowlisted files. Any such name fails first, before anything in the bundle runs.
newline=$'\n'
odd="$(cd "$app" && find . -name "*$newline*" -print -quit)"
[[ -z "$odd" ]] || die "a path in the app bundle contains a newline: $(printf '%q' "$odd")"

# The app binary, the sidecar, the icons (Assets.car for macOS 26,
# icon.icns as the CFBundleIconFile), the license notices, the signature, and the stapled ticket
# (Contents/CodeResources). Every entry that is not a directory counts, symlinks included.
expected="$(printf '%s\n' \
  Contents/CodeResources Contents/Info.plist \
  Contents/MacOS/materialize-3d Contents/MacOS/materialize-sidecar \
  Contents/Resources/Assets.car Contents/Resources/LICENSE \
  Contents/Resources/THIRD_PARTY_NOTICES.md Contents/Resources/icon.icns \
  Contents/_CodeSignature/CodeResources | sort)"
actual="$(cd "$app" && find . ! -type d | sed 's|^\./||' | sort)"
[[ "$actual" == "$expected" ]] || die "unexpected files in the app bundle:
$(diff <(echo "$expected") <(echo "$actual") || true)"

[[ "$(plutil -extract LSMinimumSystemVersion raw "$app/Contents/Info.plist")" == 26.0 ]] \
  || die "the minimum macOS is not 26.0"

entitlements="$(mktemp)"
trap 'rm -f "$entitlements"' EXIT

# The sidecar runs Bun, whose JavaScript engine compiles code at run time, so the hardened runtime must allow JIT.
sidecar="$app/Contents/MacOS/materialize-sidecar"
[[ "$(lipo -archs "$sidecar")" == arm64 ]] || die "the sidecar is not arm64-only"
codesign --verify --strict "$sidecar" || die "the sidecar's signature does not verify"
details="$(codesign -dv --verbose=4 "$sidecar" 2>&1)"
grep -q '^Identifier=com.aojdevstudio.materialize3d.sidecar$' <<<"$details" \
  || die "the sidecar's signing identifier is wrong"
grep -q "^TeamIdentifier=$team$" <<<"$details" || die "the sidecar is not signed by team $team"
grep -q "flags=.*runtime" <<<"$details" || die "the sidecar's hardened runtime is off"
codesign -d --entitlements - --xml "$sidecar" > "$entitlements" 2>/dev/null
[[ "$(plutil -convert json -o - "$entitlements")" == '{"com.apple.security.cs.allow-jit":true}' ]] \
  || die "the sidecar must hold exactly the JIT entitlement"
echo "bundle: $app holds exactly the release files, and the sidecar checks out"
