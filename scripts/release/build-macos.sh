#!/usr/bin/env bash
# Builds the signed, notarized Materialize 3D DMG for Apple Silicon from a clean
# checkout of a release tag, then checks it the way Gatekeeper will.
#
# Run it on an Apple Silicon Mac that holds a Developer ID Application identity
# in a dedicated keychain. Nothing here runs in pull request CI. Credentials come
# from the environment and are never printed:
#   RELEASE_KEYCHAIN            path to the keychain that holds the identity
#   RELEASE_KEYCHAIN_PASSWORD   its password
#   APPLE_API_KEY_ID            App Store Connect API key id (notarytool)
#   APPLE_API_ISSUER_ID         its issuer id
#   APPLE_API_PRIVATE_KEY       the .p8 key content
# CAD_RUNTIME_DIR names the arm64 CAD runtime to bundle: the Image, rootfs.img,
# and job.img that cad-runtime/build.sh arm64 writes (or the cad-runtime-arm64
# artifact of the CAD runtime workflow). They must match the pins the helper
# compiles in from cad-runtime/pins-arm64.json, or the build stops.
# ALLOW_UNTAGGED=1 permits a rehearsal build from a commit without the tag.
#
# Output: dist-release/Materialize-3D-<version>-macos-arm64.dmg and a .sha256
# file next to it. The build never enables the e2e verification harness.
set -euo pipefail

die() { echo "release: $*" >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

[[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]] || die "run on an Apple Silicon Mac"
for var in RELEASE_KEYCHAIN RELEASE_KEYCHAIN_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_PRIVATE_KEY \
  CAD_RUNTIME_DIR; do
  [[ -n "${!var:-}" ]] || die "$var is not set"
done
[[ -f "$RELEASE_KEYCHAIN" ]] || die "no keychain at $RELEASE_KEYCHAIN"
[[ -d "$CAD_RUNTIME_DIR" ]] || die "no CAD runtime at $CAD_RUNTIME_DIR"

# One version everywhere, and the tree is exactly the tagged commit.
version="$(bun -p "require('./package.json').version")"
cargo_version="$(sed -n 's/^version = "\(.*\)"$/\1/p' src-tauri/Cargo.toml | head -1)"
tauri_version="$(bun -p "require('./src-tauri/tauri.conf.json').version")"
[[ "$version" == "$cargo_version" && "$version" == "$tauri_version" ]] \
  || die "versions differ: package.json $version, Cargo.toml $cargo_version, tauri.conf.json $tauri_version"
[[ -z "$(git status --porcelain)" ]] || die "working tree is not clean"
if [[ "${ALLOW_UNTAGGED:-}" != 1 ]]; then
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse -q --verify "refs/tags/v$version^{commit}" || true)" ]] \
    || die "HEAD is not tag v$version"
fi
commit="$(git rev-parse HEAD)"

# The release keychain is unlocked for this shell's security session only. A
# keychain that sits on the user's search list while locked in the desktop
# session makes other apps raise unlock prompts, but codesign finds identities
# only through that list. So each codesign call appends the keychain to the
# list for the seconds it runs, and the caller's list is restored right after.
original_list="$(security list-keychains -d user)"
original_keychains=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line#\"}"; line="${line%\"}"
  [[ -n "$line" ]] && original_keychains+=("$line")
done <<<"$original_list"
workdir="$(mktemp -d "${TMPDIR:-/tmp}/m3d-release.XXXXXX")"
# Every step runs even when an earlier one fails, and each failure is reported
# and fails the build: a release keychain left on the search list or unlocked,
# or an API key left on disk, must not pass as a successful run.
cleanup() {
  local rc=$? failed=0 now
  if ! security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1; then
    echo "release: cleanup could not restore the keychain search list" >&2
    failed=1
  elif ! now="$(security list-keychains -d user 2>/dev/null)"; then
    echo "release: cleanup could not read back the keychain search list" >&2
    failed=1
  elif [[ "$now" != "$original_list" ]]; then
    echo "release: the keychain search list differs from the one the run started with" >&2
    failed=1
  fi
  if ! security lock-keychain "$RELEASE_KEYCHAIN" >/dev/null 2>&1; then
    echo "release: cleanup could not lock $RELEASE_KEYCHAIN" >&2
    failed=1
  fi
  if ! rm -rf "$workdir" || [[ -e "$workdir" ]]; then
    echo "release: cleanup could not delete $workdir, which holds the API key" >&2
    failed=1
  fi
  if [[ "$failed" == 1 && "$rc" == 0 ]]; then rc=1; fi
  exit "$rc"
}
trap cleanup EXIT
security unlock-keychain -p "$RELEASE_KEYCHAIN_PASSWORD" "$RELEASE_KEYCHAIN"
identity="$(security find-identity -v -p codesigning "$RELEASE_KEYCHAIN" \
  | awk -F'"' '/Developer ID Application/ { print $2; exit }')"
[[ -n "$identity" ]] || die "no Developer ID Application identity in $RELEASE_KEYCHAIN"
team="$(sed -E 's/.*\(([A-Z0-9]{10})\)$/\1/' <<<"$identity")"
sign() {
  local rc=0
  security list-keychains -d user -s "${original_keychains[@]}" "$RELEASE_KEYCHAIN"
  codesign --force --timestamp --keychain "$RELEASE_KEYCHAIN" --sign "$identity" "$@" || rc=$?
  security list-keychains -d user -s "${original_keychains[@]}"
  return "$rc"
}

keyfile="$workdir/AuthKey.p8"
( umask 077 && printf '%s\n' "$APPLE_API_PRIVATE_KEY" > "$keyfile" )
notarize() {
  xcrun notarytool submit "$1" --key "$keyfile" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait \
    | tee "$workdir/notary.txt"
  grep -q "status: Accepted" "$workdir/notary.txt" || die "notarization of $1 was not accepted"
}

# The CAD helper boots only the runtime whose digests it compiles in, so a
# runtime that does not match its own commit's pins stops the build here.
echo "release: building the CAD helper"
RUSTFLAGS="--remap-path-prefix=$HOME=~" cargo build --release --locked --manifest-path cad-host/Cargo.toml
helper_bin="${CARGO_TARGET_DIR:-$root/cad-host/target}/release/materialize-cad-host"
"$helper_bin" verify --runtime "$CAD_RUNTIME_DIR" >/dev/null \
  || die "the CAD runtime in $CAD_RUNTIME_DIR does not match the pins in cad-runtime/pins-arm64.json"

# Tauri builds the app bundle; this script adds the CAD helper and runtime,
# then signs, notarizes, and packages it.
target="${CARGO_TARGET_DIR:-$root/src-tauri/target}"
rm -rf "$target/release/bundle"
bun install --frozen-lockfile
RUSTFLAGS="--remap-path-prefix=$HOME=~" env -u VITE_M3D_E2E -u APPLE_SIGNING_IDENTITY \
  bun tauri build --bundles app
app="$target/release/bundle/macos/Materialize 3D.app"
bin="$app/Contents/MacOS/materialize-3d"
helper="$app/Contents/MacOS/materialize-cad-host"
install -m 0755 "$helper_bin" "$helper"
mkdir -p "$app/Contents/Resources/cad-runtime"
for file in Image rootfs.img job.img; do
  install -m 0644 "$CAD_RUNTIME_DIR/$file" "$app/Contents/Resources/cad-runtime/$file"
done

echo "release: signing and notarizing the app"
# Inside out: the helper gets its own signature with the virtualization
# entitlement, then the app's signature seals it with the rest of the bundle.
# One notarization covers both, and the staple on the app covers the helper,
# which as a bare executable could not carry a staple of its own.
sign --options runtime --identifier com.aojdevstudio.materialize3d.cad-host \
  --entitlements cad-host/entitlements.plist "$helper"
sign --options runtime "$app"
ditto -c -k --keepParent "$app" "$workdir/app.zip"
notarize "$workdir/app.zip"
xcrun stapler staple "$app"

echo "release: checking the app"
codesign --verify --deep --strict "$app"
details="$(codesign -dv --verbose=4 "$app" 2>&1)"
grep -q "^TeamIdentifier=$team$" <<<"$details" || die "app is not signed by team $team"
grep -q "flags=.*runtime" <<<"$details" || die "hardened runtime is off"
xcrun stapler validate "$app"
spctl --assess --type execute "$app"
[[ "$(lipo -archs "$bin")" == arm64 ]] || die "binary is not arm64-only"
plist="$app/Contents/Info.plist"
[[ "$(plutil -extract CFBundleShortVersionString raw "$plist")" == "$version" ]] || die "Info.plist version is not $version"
# grep reads a saved copy: piping strings into grep -q would fail on SIGPIPE
# under pipefail exactly when a match is found.
for exe in "$bin" "$helper"; do
  strings "$exe" > "$workdir/strings.txt"
  if grep -qE 'M3D_E2E_(TOKEN|PORT|DATA_DIR)' "$workdir/strings.txt"; then die "the e2e harness is in $exe"; fi
  if grep -qF "$HOME" "$workdir/strings.txt"; then die "$exe embeds the build machine's home path"; fi
done
if grep -rlq __M3D_E2E_DIALOGS__ dist; then die "the scripted file dialog is in the frontend"; fi
# The exact file list, the minimum macOS, the helper's signature and
# entitlement, and the bundled runtime against the helper's pins.
scripts/release/check-app-bundle.sh "$app" "$team"

echo "release: building, signing, and notarizing the DMG"
stage="$workdir/dmg"
mkdir -p "$stage"
ditto "$app" "$stage/Materialize 3D.app"
ln -s /Applications "$stage/Applications"
dmg="$workdir/Materialize 3D.dmg"
hdiutil create -volname "Materialize 3D" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg" >/dev/null
sign "$dmg"
notarize "$dmg"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg"

out="$root/dist-release"
name="Materialize-3D-$version-macos-arm64.dmg"
mkdir -p "$out"
cp "$dmg" "$out/$name"
( cd "$out" && shasum -a 256 "$name" > "$name.sha256" )
echo "release: $out/$name"
echo "release: commit $commit"
echo "release: signed by $identity"
cat "$out/$name.sha256"
