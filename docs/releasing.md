# Release Materialize 3D for macOS

Releases are built on an Apple Silicon Mac by `scripts/release/build-macos.sh`, outside GitHub Actions. Signing and notarization credentials never reach a pull request job.

## What you need

- An Apple Silicon Mac with Xcode command line tools, Bun, and Rust.
- A keychain that holds a Developer ID Application identity, and its password.
- An App Store Connect API key for `notarytool`: key id, issuer id, and the `.p8` content.

## Steps

1. Set the same version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, and land that change through a pull request.
2. Tag the merged commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v0.1.0 && git push origin v0.1.0
   ```

3. In a clean checkout of the tag, export the credentials and run the script:

   ```bash
   export RELEASE_KEYCHAIN=~/Library/Keychains/<release>.keychain-db
   export RELEASE_KEYCHAIN_PASSWORD=... APPLE_API_KEY_ID=... APPLE_API_ISSUER_ID=... APPLE_API_PRIVATE_KEY="$(cat AuthKey.p8)"
   scripts/release/build-macos.sh
   ```

   The script refuses a dirty tree, an untagged commit, or mismatched versions. It signs with the hardened runtime and notarizes and staples both the app and the DMG. Then it checks Gatekeeper acceptance, the architecture, the absence of the e2e harness and of build-machine paths, and the exact file list of the app bundle. It writes `dist-release/Materialize-3D-<version>-macos-arm64.dmg` and a `.sha256` file.

4. Install the DMG on a Mac and run through `docs/install-macos.md` before publishing.
5. Publish the release with the DMG and its checksum:

   ```bash
   gh release create v0.1.0 --title "Materialize 3D 0.1.0" --notes-file <notes.md> \
     dist-release/Materialize-3D-0.1.0-macos-arm64.dmg dist-release/Materialize-3D-0.1.0-macos-arm64.dmg.sha256
   ```

Physical print validation is separate from this checklist. A release never records a print result.
