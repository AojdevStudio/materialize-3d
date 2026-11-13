# Release Materialize 3D for macOS

Releases are built on an Apple Silicon Mac by `scripts/release/build-macos.sh`, outside GitHub Actions. Signing and notarization credentials never reach a pull request job.

The 0.3.0 candidate replaces the 0.2.2 app with a chat studio. The commands below describe the release procedure. They do not report a completed build or acceptance run.

## What you need

- An Apple Silicon Mac on macOS 26 or later with Xcode command line tools, Bun, and Rust. The app requires macOS 26.0.
- A keychain that holds a Developer ID Application identity, and its password.
- An App Store Connect API key for `notarytool`: key id, issuer id, and the `.p8` content.
- The updater signing key: BWS secrets `MATERIALIZE3D_TAURI_UPDATER_PRIVATE_KEY` and `MATERIALIZE3D_TAURI_UPDATER_KEY_PASSWORD`. The build reads them as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Its public key is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. This minisign key is separate from the Developer ID certificate. Never generate a new one for a release: installed apps accept only updates signed by the key they were built with.

### Release keychain input limits

`build-macos.sh` requires nonempty `RELEASE_KEYCHAIN` and `RELEASE_KEYCHAIN_PASSWORD`. Both values must contain only printable ASCII, with no single quotes, double quotes, or backslashes. The keychain path must not start with a dash and must name an existing file.

The script passes the unlock command to `security -i` on standard input. The complete command, including its quoting, spaces, and final newline, must be shorter than 1024 bytes. Preflight rejects unsupported characters, an overlong command, or a leading dash without printing the input values. Unlock failures report only the exit status.

Do not rotate or rewrite user credentials to satisfy these limits. If existing credentials cannot meet them, record the unmet prerequisite and stop the release build.

## Steps

1. Set the same version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Update only the root `materialize-3d` package entry in `src-tauri/Cargo.lock`. Keep dependency versions unchanged. Prepare `docs/releases/v0.3.0.md` with source capabilities and publication requirements, then land the version change through a pull request. Keep the final source commit, DMG checksum, and measured acceptance results out of tracked source. They go in the release body and in the acceptance record in the meta repo (step 5).
2. Tag the merged commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v0.3.0 && git push origin v0.3.0
   ```

3. In a clean checkout of the tag, have the authorized secret source inject the existing credentials into the shell environment. Set `RELEASE_KEYCHAIN` to the existing release keychain path. Do not type secret values into commands, enable shell tracing, or print the environment. With those values already supplied, export the variable names and run the script:

   ```bash
   set +x
   unset ALLOW_UNTAGGED
   export RELEASE_KEYCHAIN RELEASE_KEYCHAIN_PASSWORD
   export APPLE_API_KEY_ID APPLE_API_ISSUER_ID APPLE_API_PRIVATE_KEY
   export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   scripts/release/build-macos.sh
   ```

   With `ALLOW_UNTAGGED` unset, the script refuses a dirty tree, an untagged commit, mismatched versions, or a `TAURI_CONFIG` override. Never use the rehearsal override for the final build. It signs the sidecar first, with the hardened runtime and the JIT entitlement, then the app around it, and notarizes and staples both the app and the DMG. The app's staple covers the sidecar. Then it checks Gatekeeper acceptance, the architecture, the absence of the e2e harness and of build-machine paths in both executables, and runs `scripts/release/check-app-bundle.sh`: the exact file list of the app bundle, macOS 26.0 as the minimum, and the sidecar's signature and its only entitlement. It writes `dist-release/Materialize-3D-<version>-macos-arm64.dmg` and a `.sha256` file.

   The script also writes the update assets from the same stapled app, after the bundle check and before the DMG:

   - `Materialize-3D-<version>-macos-arm64.app.tar.gz`, the update archive. The script unpacks it and checks the signature, the staple, and the bundle file list again.
   - `Materialize-3D-<version>-macos-arm64.app.tar.gz.sig`, its minisign signature, bound to the version. The script stops when the signature's key id differs from the public key in `tauri.conf.json`.
   - `Materialize-3D-<version>-macos-arm64.app.tar.gz.sha256`.
   - `latest.json`, the update feed: version, notes, date, signature, and the archive's download URL on the `v<version>` release.

   The script stops when either updater secret is missing or signing fails.

4. Run the [installed GUI checklist](verify-on-mac.md) on that exact DMG. Keep the sliced 3MF and its hash, the Bambu Studio P2S 0.4 mm proof, and the GUI recording.
5. Complete the required software acceptance record below. Store it, its evidence, and the build's `.sha256` files in the meta repo's cycle folder, `cycles/<cycle>/release-v<version>/` in `AojdevStudio/materialize-3d-meta`, not on the release. Then write the release body, `dist-release/release-notes-short.md`. A visitor must see at once which file to download, so the body stays short and the full notes stay in `docs/releases/v<version>.md`, linked from the body. Put the exact tagged source commit and the final DMG checksum only in the body's collapsed part and in the record. Do not edit tracked notes to insert them. Keep shared release tags unchanged. If source or packaging changes, build and test a new candidate. Required software checks and release approval gate publication.

   The body has this shape, copied from the v0.3.1 release:

   ```markdown
   ## Download

   ### [⬇ Download Materialize 3D for Mac](https://github.com/AojdevStudio/materialize-3d/releases/download/v<version>/Materialize-3D-<version>-macos-arm64.dmg)

   For Macs with Apple Silicon (M1 or newer) on macOS 26 or later.

   Open the file, then drag Materialize 3D into Applications. <one line on what the first launch does>

   ## What's new in <version>

   - <the change most people notice>
   - <the second>
   - <the third>

   <one line for each earlier version that reads the update banner, as v0.3.1 does for 0.3.0 and 0.2.2>

   [Full release notes](https://github.com/AojdevStudio/materialize-3d/blob/v<version>/docs/releases/v<version>.md)

   <details>
   <summary>The other files below</summary>

   You only need the Mac download above. The other files are for the app's automatic updates and for the source code.

   DMG SHA-256: `<full SHA-256 of the DMG>`
   Signed and notarized by Apple. Built from commit `<short commit of the tag>`.
   </details>
   ```

   After they pass, publish only the DMG and the three update files. Never upload the `.sha256` files, the acceptance record, or its evidence. Each file gets a label with gh's `file#label` form, so the release page says which one to download. Run this from the tag's checkout:

   ```bash
   V="$(jq -r .version package.json)"
   gh release create "v$V" --verify-tag --title "Materialize 3D $V" --notes-file dist-release/release-notes-short.md \
     "dist-release/Materialize-3D-$V-macos-arm64.dmg#Materialize-3D-$V-mac.dmg  (download this one)" \
     "dist-release/latest.json#latest.json  (for automatic updates, skip)" \
     "dist-release/Materialize-3D-$V-macos-arm64.app.tar.gz#updater-archive.tar.gz  (for automatic updates, skip)" \
     "dist-release/Materialize-3D-$V-macos-arm64.app.tar.gz.sig#updater-signature.sig  (for automatic updates, skip)"
   ```

   A label changes only what the page shows. The files keep the names the build wrote. Never rename them, because `latest.json` and installed apps fetch them by those names.

   Publishing a release as **Latest** is what updates installed apps. Each installed app reads `https://github.com/AojdevStudio/materialize-3d/releases/latest/download/latest.json` at launch, and offers the update when that version is newer than its own. A draft or a prerelease never reaches installed apps. To hold a release back, publish it as a draft or prerelease, or leave the earlier release marked Latest until the download check below passes.

   The first release that contains the updater must still be installed by hand from its DMG. Only later releases arrive as updates.

6. Download the published files from the actual release. The release must hold exactly four files, with the labels above. Compare the downloaded DMG's full SHA-256 with the build's `.sha256` file and with the DMG SHA-256 in the release body. Compare the downloaded archive's full SHA-256 with its build checksum. Compare the downloaded `latest.json` and `.sig` byte for byte with the files in `dist-release/`. Then confirm that the Latest feed URL serves the same `latest.json`. Stop on any mismatch, missing file, or extra file. Store this published-download proof with the acceptance record in the meta repo.

   ```bash
   V="$(jq -r .version package.json)"
   gh release view "v$V" -R AojdevStudio/materialize-3d --json assets --jq '.assets[] | "\(.name) | \(.label)"'
   mkdir -p dist-release/published && cd dist-release/published
   gh release download "v$V" -R AojdevStudio/materialize-3d
   shasum -a 256 "Materialize-3D-$V-macos-arm64.dmg"
   cat "../Materialize-3D-$V-macos-arm64.dmg.sha256"
   gh release view "v$V" -R AojdevStudio/materialize-3d --json body --jq .body | grep 'DMG SHA-256'
   shasum -a 256 "Materialize-3D-$V-macos-arm64.app.tar.gz"
   cat "../Materialize-3D-$V-macos-arm64.app.tar.gz.sha256"
   cmp latest.json ../latest.json
   cmp "Materialize-3D-$V-macos-arm64.app.tar.gz.sig" "../Materialize-3D-$V-macos-arm64.app.tar.gz.sig"
   curl -fsSL https://github.com/AojdevStudio/materialize-3d/releases/latest/download/latest.json | cmp - ../latest.json
   ```

   The last command passes only after the release is published as Latest.

## Required software acceptance record

The completed record is a publication gate. Store it in the meta repo's cycle folder, `cycles/<cycle>/release-v<version>/`, with its recordings, screenshots, and logs. It never goes on the release. Keep it outside tracked source so recording the final bytes cannot change their source commit. Do not publish with missing or failed required software checks. A rehearsal result cannot replace a final tagged DMG test.

Record the exact source tag and commit, DMG filename and full SHA-256, and installed bundle version. Identify each machine, macOS version, chip, isolation option, effective HOME and `PATH`, and whether that machine built the DMG.

Include every result required by the [installed GUI checklist](verify-on-mac.md): the provider and model, the prompt and its follow-ups, the sliced 3MF's path and full SHA-256, Bambu Studio 02.08.02.61 P2S 0.4 mm proof, and each persistence, interruption, failure, and recovery result. Report failures and unrun checks with reasons. State all remaining limits.

## Complete installed GUI acceptance

Follow [Verify the installed Mac app](verify-on-mac.md) on the built DMG. Its native verification section covers the signed CuaDriver route exercised on the mini. Use real input and native dialogs. Record a missing tool or permission as an unmet prerequisite rather than substituting the debug e2e endpoint.

A fresh standard account logged into a desktop is the strongest GUI isolation option. An isolated HOME and test keychain under an existing console login are a separate option. Label the GUI evidence with the option used. Neither an isolated HOME nor a fresh account proves an independent-machine test. Both GUI options require fresh app data, only the system `PATH`, and no checkout runtime dependencies.

`.agents/skills/verify-materialize-3d/scripts/mac.ts` launches an e2e debug bundle, not the release installed from the DMG.
