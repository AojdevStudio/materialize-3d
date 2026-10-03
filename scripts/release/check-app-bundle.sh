#!/usr/bin/env bash
# Checks a built or installed Materialize 3D app against what a release must hold:
#   scripts/release/check-app-bundle.sh <path to Materialize 3D.app> <team id>
# Exactly the allowlisted files and nothing else, macOS 26.0 as the minimum, the CAD helper arm64-only and signed
# by the team under the hardened runtime with the virtualization entitlement and no other, and the bundled CAD
# runtime matching the pins compiled into that helper. build-macos.sh runs it on the stapled app, and
# clean-install-test-macos.sh on the copy a fresh account installs.
set -euo pipefail
die() { echo "bundle: $*" >&2; exit 1; }
[[ $# -eq 2 ]] || { echo "usage: $0 <app> <team id>" >&2; exit 2; }
app="$1" team="$2"
[[ -f "$app/Contents/Info.plist" ]] || die "no app bundle at $app"

# The app binary, the CAD helper and its runtime, the icons (Assets.car for macOS 26, icon.icns as the
# CFBundleIconFile), the license notices, the signature, and the stapled ticket (Contents/CodeResources). Every
# entry that is not a directory counts, symlinks included.
expected="$(printf '%s\n' \
  Contents/CodeResources Contents/Info.plist \
  Contents/MacOS/materialize-3d Contents/MacOS/materialize-cad-host \
  Contents/Resources/AGPL-3.0.txt Contents/Resources/Assets.car Contents/Resources/LICENSE \
  Contents/Resources/THIRD_PARTY_NOTICES.md Contents/Resources/icon.icns \
  Contents/Resources/cad-runtime/Image Contents/Resources/cad-runtime/job.img \
  Contents/Resources/cad-runtime/rootfs.img \
  Contents/_CodeSignature/CodeResources | sort)"
actual="$(cd "$app" && find . ! -type d | sed 's|^\./||' | sort)"
[[ "$actual" == "$expected" ]] || die "unexpected files in the app bundle:
$(diff <(echo "$expected") <(echo "$actual") || true)"

[[ "$(plutil -extract LSMinimumSystemVersion raw "$app/Contents/Info.plist")" == 26.0 ]] \
  || die "the minimum macOS is not 26.0"

helper="$app/Contents/MacOS/materialize-cad-host"
[[ "$(lipo -archs "$helper")" == arm64 ]] || die "the CAD helper is not arm64-only"
codesign --verify --strict "$helper" || die "the CAD helper's signature does not verify"
details="$(codesign -dv --verbose=4 "$helper" 2>&1)"
grep -q '^Identifier=com.aojdevstudio.materialize3d.cad-host$' <<<"$details" \
  || die "the CAD helper's signing identifier is wrong"
grep -q "^TeamIdentifier=$team$" <<<"$details" || die "the CAD helper is not signed by team $team"
grep -q "flags=.*runtime" <<<"$details" || die "the CAD helper's hardened runtime is off"
entitlements="$(mktemp)"
trap 'rm -f "$entitlements"' EXIT
codesign -d --entitlements - --xml "$helper" > "$entitlements" 2>/dev/null
[[ "$(plutil -convert json -o - "$entitlements")" == '{"com.apple.security.virtualization":true}' ]] \
  || die "the CAD helper must hold exactly the virtualization entitlement"
"$helper" verify --runtime "$app/Contents/Resources/cad-runtime" >/dev/null \
  || die "the bundled CAD runtime does not match the helper's pins"
echo "bundle: $app holds exactly the release files; helper and runtime check out"
