# Release Materialize 3D for macOS

Releases are built on an Apple Silicon Mac by `scripts/release/build-macos.sh`, outside GitHub Actions. Signing and notarization credentials never reach a pull request job.

The 0.2.2 candidate adds the in-app updater and fixes bugs found after 0.2.1. The commands below describe the release procedure. They do not report a completed build or acceptance run.

## What you need

- An Apple Silicon Mac on macOS 26 or later with Xcode command line tools, Bun, and Rust. The app requires macOS 26.0.
- A keychain that holds a Developer ID Application identity, and its password.
- An App Store Connect API key for `notarytool`: key id, issuer id, and the `.p8` content.
- The updater signing key: BWS secrets `MATERIALIZE3D_TAURI_UPDATER_PRIVATE_KEY` and `MATERIALIZE3D_TAURI_UPDATER_KEY_PASSWORD`. The build reads them as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Its public key is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. This minisign key is separate from the Developer ID certificate. Never generate a new one for a release: installed apps accept only updates signed by the key they were built with.
- The arm64 CAD runtime for the tagged commit: the output of `cad-runtime/build.sh arm64` on a Linux machine with Docker, buildx, and arm64 binfmt. It must match `cad-runtime/pins-arm64.json`, which the CAD helper compiles in.

### Release keychain input limits

`build-macos.sh` requires nonempty `RELEASE_KEYCHAIN` and `RELEASE_KEYCHAIN_PASSWORD`. Both values must contain only printable ASCII, with no single quotes, double quotes, or backslashes. The keychain path must not start with a dash and must name an existing file.

The script passes the unlock command to `security -i` on standard input. The complete command, including its quoting, spaces, and final newline, must be shorter than 1024 bytes. Preflight rejects unsupported characters, an overlong command, or a leading dash without printing the input values. Unlock failures report only the exit status.

Do not rotate or rewrite user credentials to satisfy these limits. If existing credentials cannot meet them, record the unmet prerequisite and stop the release build.

## Steps

1. Set the same version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Update only the root `materialize-3d` package entry in `src-tauri/Cargo.lock`. Keep dependency versions and `cad-host` versions unchanged. Prepare `docs/releases/v0.2.2.md` with source capabilities and publication requirements, then land the version change through a pull request. Keep the final source commit, DMG checksum, and measured acceptance results in the external release body and attached software acceptance record, not tracked source.
2. Tag the merged commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v0.2.2 && git push origin v0.2.2
   ```

3. In a clean checkout of the tag, have the authorized secret source inject the existing credentials into the shell environment. Set `RELEASE_KEYCHAIN` to the existing release keychain path and `CAD_RUNTIME_DIR` to the directory containing `Image`, `rootfs.img`, and `job.img`. Do not type secret values into commands, enable shell tracing, or print the environment. With those values already supplied, export the variable names and run the script:

   ```bash
   set +x
   unset ALLOW_UNTAGGED
   export RELEASE_KEYCHAIN RELEASE_KEYCHAIN_PASSWORD
   export APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_PRIVATE_KEY
   export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   export CAD_RUNTIME_DIR
   scripts/release/build-macos.sh
   ```

   With `ALLOW_UNTAGGED` unset, the script refuses a dirty tree, an untagged commit, mismatched versions, a `TAURI_CONFIG` override, or a CAD runtime that does not match the helper's pins. Never use the rehearsal override for the final build. It builds the CAD helper from `cad-host/` and places it at `Contents/MacOS/materialize-cad-host`, with the runtime at `Contents/Resources/cad-runtime/{Image,rootfs.img,job.img}`. It signs the helper first, with the hardened runtime and the virtualization entitlement, then the app around it, and notarizes and staples both the app and the DMG; the app's staple covers the helper. Then it checks Gatekeeper acceptance, the architecture, the absence of the e2e harness and of build-machine paths in both executables, and runs `scripts/release/check-app-bundle.sh`: the exact file list of the app bundle, macOS 26.0 as the minimum, the helper's signature and its only entitlement, and the bundled runtime against the helper's pins. It writes `dist-release/Materialize-3D-<version>-macos-arm64.dmg` and a `.sha256` file.

   The script also writes the update assets from the same stapled app, after the bundle check and before the DMG:

   - `Materialize-3D-<version>-macos-arm64.app.tar.gz`, the update archive. The script unpacks it and checks the signature, the staple, and the bundle file list again.
   - `Materialize-3D-<version>-macos-arm64.app.tar.gz.sig`, its minisign signature, bound to the version. The script stops when the signature's key id differs from the public key in `tauri.conf.json`.
   - `Materialize-3D-<version>-macos-arm64.app.tar.gz.sha256`.
   - `latest.json`, the update feed: version, notes, date, signature, and the archive's download URL on the `v<version>` release.

   The script stops when either updater secret is missing or signing fails.

4. Run the [installed GUI checklist](verify-on-mac.md) on that exact DMG. Keep the sliced 3MF and its hash, the Bambu Studio P2S 0.4 mm proof, and the GUI recording.
5. Complete the required software acceptance record below and prepare an external release body from the source notes. Put the exact tagged source commit and final DMG checksum in both. Do not edit tracked notes to insert their own source commit or DMG checksum. Keep shared release tags unchanged. If source or packaging changes, build and test a new candidate. Required software checks and release approval gate publication. After they pass, publish the DMG, its checksum, and the completed record. The filenames below require the completed files described here, not placeholders.

   ```bash
   gh release create v0.2.2 --verify-tag --title "Materialize 3D 0.2.2" --notes-file dist-release/release-notes.md \
     dist-release/Materialize-3D-0.2.2-macos-arm64.dmg dist-release/Materialize-3D-0.2.2-macos-arm64.dmg.sha256 \
     dist-release/latest.json dist-release/Materialize-3D-0.2.2-macos-arm64.app.tar.gz \
     dist-release/Materialize-3D-0.2.2-macos-arm64.app.tar.gz.sig \
     dist-release/software-acceptance.md
   ```

   Attach the three update assets under exactly these names, because `latest.json` names the archive's URL.

   Publishing a release as **Latest** is what updates installed apps. Each installed app reads `https://github.com/AojdevStudio/materialize-3d/releases/latest/download/latest.json` at launch, and offers the update when that version is newer than its own. A draft or a prerelease never reaches installed apps. To hold a release back, publish it as a draft or prerelease, or leave the earlier release marked Latest until the download check below passes.

   The first release that contains the updater must still be installed by hand from its DMG. Only later releases arrive as updates.

6. Download the published DMG, checksum file, update assets, and record from the actual release. Compare the downloaded DMG's full SHA-256 with the build checksum, published checksum file, release body, and acceptance record. Compare the downloaded archive's full SHA-256 with its build checksum. Compare the downloaded `latest.json` and `.sig` byte for byte with the files in `dist-release/`. Then confirm that the Latest feed URL serves the same `latest.json`. Stop on any mismatch or missing attachment. Retain this published-download proof with the release evidence.

   ```bash
   mkdir -p dist-release/published && cd dist-release/published
   gh release download v0.2.2 -R AojdevStudio/materialize-3d
   shasum -a 256 Materialize-3D-0.2.2-macos-arm64.app.tar.gz
   cat ../Materialize-3D-0.2.2-macos-arm64.app.tar.gz.sha256
   cmp latest.json ../latest.json
   cmp Materialize-3D-0.2.2-macos-arm64.app.tar.gz.sig ../Materialize-3D-0.2.2-macos-arm64.app.tar.gz.sig
   curl -fsSL https://github.com/AojdevStudio/materialize-3d/releases/latest/download/latest.json | cmp - ../latest.json
   ```

   The last command passes only after the release is published as Latest.

## Required software acceptance record

The completed record is a publication gate. Attach it to the eventual release with accessible recordings, screenshots, and logs. Keep it outside tracked source so recording the final bytes cannot change their source commit. Do not publish with missing or failed required software checks. A rehearsal result cannot replace a final tagged DMG test.

Record the exact source tag and commit, DMG filename and full SHA-256, and installed bundle version. Identify each machine, macOS version, chip, isolation option, effective HOME and `PATH`, and whether that machine built the DMG.

Include every result required by the [installed GUI checklist](verify-on-mac.md): the provider and model, the prompt and its follow-ups, the sliced 3MF's path and full SHA-256, Bambu Studio 02.08.02.61 P2S 0.4 mm proof, and each persistence, interruption, failure, and recovery result. Report failures and unrun checks with reasons. State all remaining limits.

## Complete installed GUI acceptance

Follow [Verify the installed Mac app](verify-on-mac.md) on the built DMG. Its native verification section covers the signed CuaDriver route exercised on the mini. Use real input and native dialogs. Record a missing tool or permission as an unmet prerequisite rather than substituting the debug e2e endpoint.

A fresh standard account logged into a desktop is the strongest GUI isolation option. An isolated HOME and test keychain under an existing console login are a separate option. Label the GUI evidence with the option used. Neither an isolated HOME nor a fresh account proves an independent-machine test. Both GUI options require fresh app data, only the system `PATH`, and no checkout runtime dependencies.

`.agents/skills/verify-materialize-3d/scripts/mac.ts` launches an e2e debug bundle, not the release installed from the DMG.
