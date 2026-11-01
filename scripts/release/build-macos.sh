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
#   TAURI_SIGNING_PRIVATE_KEY           the updater's minisign private key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password
# CAD_RUNTIME_DIR names the arm64 CAD runtime to bundle: the Image, rootfs.img,
# and job.img that cad-runtime/build.sh arm64 writes (or the cad-runtime-arm64
# artifact of the CAD runtime workflow). They must match the pins the helper
# compiles in from cad-runtime/pins-arm64.json, or the build stops.
# ALLOW_UNTAGGED=1 permits a rehearsal build from a commit without the tag. Only
# a rehearsal may set TAURI_CONFIG, which changes the config built into the app
# (for example, a local update feed for an update test).
#
# Output in dist-release/: Materialize-3D-<version>-macos-arm64.dmg with a .sha256
# file, and the update assets: Materialize-3D-<version>-macos-arm64.app.tar.gz
# (the final notarized app), its .sig and .sha256, and latest.json, the feed
# installed apps read once the release is published as Latest. The build never
# enables the e2e verification harness.
set -euo pipefail
set +x

die() { echo "release: $*" >&2; exit 1; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

[[ "$(uname -s)/$(uname -m)" == Darwin/arm64 ]] || die "run on an Apple Silicon Mac"
for var in RELEASE_KEYCHAIN RELEASE_KEYCHAIN_PASSWORD APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_PRIVATE_KEY \
  TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD CAD_RUNTIME_DIR; do
  [[ -n "${!var:-}" ]] || die "$var is not set"
done
# security -i has its own quoting and line parser. Reject ambiguous input and
# keep the command below 1024 bytes rather than risk changing either argument.
unlock_line="$(builtin printf 'unlock-keychain -p "%s" "%s"' "$RELEASE_KEYCHAIN_PASSWORD" "$RELEASE_KEYCHAIN")"
(
  export LC_ALL=C
  for var in RELEASE_KEYCHAIN_PASSWORD RELEASE_KEYCHAIN; do
    value="${!var}"
    [[ "$value" != *[![:print:]]* && "$value" != *[\"\'\\]* ]] \
      || die "$var must use printable ASCII without quotes or backslashes for security -i"
  done
  [[ ${#unlock_line} -lt 1023 ]] \
    || die "security -i unlock command must be shorter than 1024 bytes including its newline"
)
[[ "$RELEASE_KEYCHAIN" != -* ]] || die "RELEASE_KEYCHAIN must not start with a dash"
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
if [[ -n "${TAURI_CONFIG:-}" && "${ALLOW_UNTAGGED:-}" != 1 ]]; then
  die "TAURI_CONFIG is set: a release builds tauri.conf.json exactly as committed"
fi

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
# security -i can echo its input on either output stream, including on failure.
builtin printf '%s\n' "$unlock_line" \
  | security -i >/dev/null 2>&1 || {
    rc=$?
    echo "release: keychain unlock failed (status $rc)" >&2
    exit "$rc"
  }
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
# then signs, notarizes, and packages it. M3D_CAD_HELPER_TEAM compiles the
# signing team into the app, which then trusts only a helper that team signed.
target="${CARGO_TARGET_DIR:-$root/src-tauri/target}"
rm -rf "$target/release/bundle"
bun install --frozen-lockfile
# The updater key signs only the finished archive below, so the app build never sees it.
RUSTFLAGS="--remap-path-prefix=$HOME=~" M3D_CAD_HELPER_TEAM="$team" env -u VITE_M3D_E2E -u APPLE_SIGNING_IDENTITY \
  -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD bun tauri build --bundles app
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
  if grep -qE 'M3D_E2E_(TOKEN|PORT|DATA_DIR|UPDATE_FEED)' "$workdir/strings.txt"; then die "the e2e harness is in $exe"; fi
  if grep -qF "$HOME" "$workdir/strings.txt"; then die "$exe embeds the build machine's home path"; fi
done
# The team the app requires of its CAD helper, compiled in from M3D_CAD_HELPER_TEAM above.
strings "$bin" > "$workdir/strings.txt"
grep -qF "$team" "$workdir/strings.txt" || die "the app does not require its CAD helper to be signed by team $team"
if grep -rlq __M3D_E2E_DIALOGS__ dist; then die "the scripted file dialog is in the frontend"; fi
# The exact file list, the minimum macOS, the helper's signature and
# entitlement, and the bundled runtime against the helper's pins.
scripts/release/check-app-bundle.sh "$app" "$team"

# The update archive holds the app exactly as notarized and stapled above. Its
# minisign signature is what installed apps check before they replace
# themselves, and it binds the version, which tauri.conf.json requires.
echo "release: building and signing the update archive"
out="$root/dist-release"
mkdir -p "$out"
archive_name="Materialize-3D-$version-macos-arm64.app.tar.gz"
archive="$out/$archive_name"
rm -f "$archive" "$archive.sig" "$archive.sha256" "$out/latest.json"
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --no-acls --no-fflags -czf "$archive" \
  -C "$(dirname "$app")" "$(basename "$app")"
unpacked="$workdir/unpacked"
mkdir -p "$unpacked"
tar -xzf "$archive" -C "$unpacked"
codesign --verify --deep --strict "$unpacked/Materialize 3D.app"
xcrun stapler validate "$unpacked/Materialize 3D.app"
scripts/release/check-app-bundle.sh "$unpacked/Materialize 3D.app" "$team"
bun tauri signer sign --app-version "$version" "$archive" >/dev/null || die "signing the update archive failed"
[[ -s "$archive.sig" ]] || die "the updater signer wrote no signature"
# A signature from any key but the one tauri.conf.json trusts would make every
# installed app refuse this update, so the key ids must match.
key_id() { base64 -d <<<"$1" | sed -n 2p | base64 -d | head -c 10 | tail -c 8 | xxd -p; }
trusted="$(key_id "$(bun -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")")"
[[ -n "$trusted" && "$(key_id "$(cat "$archive.sig")")" == "$trusted" ]] \
  || die "the update archive is not signed by the key in tauri.conf.json"
UPDATE_VERSION="$version" UPDATE_SIGNATURE="$(cat "$archive.sig")" \
  UPDATE_URL="https://github.com/AojdevStudio/materialize-3d/releases/download/v$version/$archive_name" \
  UPDATE_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" bun -e '
    const version = process.env.UPDATE_VERSION
    console.log(JSON.stringify({
      version,
      notes: `Materialize 3D ${version}. What changed: https://github.com/AojdevStudio/materialize-3d/releases/tag/v${version}`,
      pub_date: process.env.UPDATE_DATE,
      platforms: { "darwin-aarch64": { signature: process.env.UPDATE_SIGNATURE, url: process.env.UPDATE_URL } },
    }, null, 2))' > "$out/latest.json"
( cd "$out" && shasum -a 256 "$archive_name" > "$archive_name.sha256" )

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

name="Materialize-3D-$version-macos-arm64.dmg"
cp "$dmg" "$out/$name"
( cd "$out" && shasum -a 256 "$name" > "$name.sha256" )
echo "release: $out/$name"
echo "release: commit $commit"
echo "release: signed by $identity"
cat "$out/$name.sha256"
echo "release: update assets $out/latest.json, $archive_name and its .sig"
cat "$out/$archive_name.sha256"
