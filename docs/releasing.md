# Release Materialize 3D for macOS

Releases are built on an Apple Silicon Mac by `scripts/release/build-macos.sh`, outside GitHub Actions. Signing and notarization credentials never reach a pull request job.

The 0.2.1 candidate updates libraries with security advisories and fixes bugs found after 0.2.0. The commands below describe the release procedure. They do not report a completed build or acceptance run.

## What you need

- An Apple Silicon Mac on macOS 26 or later with Xcode command line tools, Bun, and Rust. The app requires macOS 26.0.
- A keychain that holds a Developer ID Application identity, and its password.
- An App Store Connect API key for `notarytool`: key id, issuer id, and the `.p8` content.
- The updater signing key: BWS secrets `MATERIALIZE3D_TAURI_UPDATER_PRIVATE_KEY` and `MATERIALIZE3D_TAURI_UPDATER_KEY_PASSWORD`. The build reads them as `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Its public key is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. This minisign key is separate from the Developer ID certificate. Never generate a new one for a release: installed apps accept only updates signed by the key they were built with.
- The arm64 CAD runtime for the tagged commit: the `cad-runtime-arm64` artifact of a manual `CAD runtime` run on the tag (`gh workflow run cad-runtime.yml --ref v0.2.0`), which always does the full work, or the output of `cad-runtime/build.sh arm64` on a Linux machine with Docker, buildx, and arm64 binfmt. Either way it must match `cad-runtime/pins-arm64.json`, which the CAD helper compiles in.

### Release keychain input limits

`build-macos.sh` requires nonempty `RELEASE_KEYCHAIN` and `RELEASE_KEYCHAIN_PASSWORD`. Both values must contain only printable ASCII, with no single quotes, double quotes, or backslashes. The keychain path must not start with a dash and must name an existing file.

The script passes the unlock command to `security -i` on standard input. The complete command, including its quoting, spaces, and final newline, must be shorter than 1024 bytes. Preflight rejects unsupported characters, an overlong command, or a leading dash without printing the input values. Unlock failures report only the exit status.

Do not rotate or rewrite user credentials to satisfy these limits. If existing credentials cannot meet them, record the unmet prerequisite and stop the release build.

## Steps

1. Set the same version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Update only the root `materialize-3d` package entry in `src-tauri/Cargo.lock`. Keep dependency versions and `cad-host` versions unchanged. Prepare `docs/releases/v0.2.1.md` with source capabilities and publication requirements, then land the version change through a pull request. Keep the final source commit, DMG checksum, and measured acceptance results in the external release body and attached software acceptance record, not tracked source.
2. Tag the merged commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v0.2.1 && git push origin v0.2.1
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

   With `ALLOW_UNTAGGED` unset, the script refuses a dirty tree, an untagged commit, mismatched versions, a `TAURI_CONFIG` override, or a CAD runtime that does not match the helper's pins. Never use the rehearsal override for the final build. It builds the CAD helper from `cad-host/` and places it at `Contents/MacOS/materialize-cad-host`, with the runtime at `Contents/Resources/cad-runtime/{Image,rootfs.img,job.img}`. It compiles the signing team into the app with `M3D_CAD_HELPER_TEAM` and requires that team for the helper. It signs the helper first, with the hardened runtime and the virtualization entitlement, then the app around it, and notarizes and staples both the app and the DMG; the app's staple covers the helper. Then it checks Gatekeeper acceptance, the architecture, the absence of the e2e harness and of build-machine paths in both executables, and runs `scripts/release/check-app-bundle.sh`: the exact file list of the app bundle, macOS 26.0 as the minimum, the helper's signature and its only entitlement, and the bundled runtime against the helper's pins. It writes `dist-release/Materialize-3D-<version>-macos-arm64.dmg` and a `.sha256` file.

   The script also writes the update assets from the same stapled app, after the bundle check and before the DMG:

   - `Materialize-3D-<version>-macos-arm64.app.tar.gz`, the update archive. The script unpacks it and checks the signature, the staple, and the bundle file list again.
   - `Materialize-3D-<version>-macos-arm64.app.tar.gz.sig`, its minisign signature, bound to the version. The script stops when the signature's key id differs from the public key in `tauri.conf.json`.
   - `Materialize-3D-<version>-macos-arm64.app.tar.gz.sha256`.
   - `latest.json`, the update feed: version, notes, date, signature, and the archive's download URL on the `v<version>` release.

   The script stops when either updater secret is missing or signing fails.

4. Run the clean-install and installed-release scripts below. Then run the [installed GUI checklist](verify-on-mac.md) on that exact DMG, with OpenAI chat for both signs and parts. Keep the exported 3MFs, matching approval and export hashes, Bambu Studio P2S 0.4 mm slice proof, and the GUI recording. Backend and MCP checks do not replace this GUI run.
5. Complete the required software acceptance record below and prepare an external release body from the source notes. Put the exact tagged source commit and final DMG checksum in both. Do not edit tracked notes to insert their own source commit or DMG checksum. Keep shared release tags unchanged. If source or packaging changes, build and test a new candidate. Required software checks and release approval gate publication. After they pass, publish the DMG, its checksum, the completed record, and both actual approved exports. The filenames below require the completed files described here, not placeholders.

   ```bash
   gh release create v0.2.1 --verify-tag --title "Materialize 3D 0.2.1" --notes-file dist-release/release-notes.md \
     dist-release/Materialize-3D-0.2.1-macos-arm64.dmg dist-release/Materialize-3D-0.2.1-macos-arm64.dmg.sha256 \
     dist-release/latest.json dist-release/Materialize-3D-0.2.1-macos-arm64.app.tar.gz \
     dist-release/Materialize-3D-0.2.1-macos-arm64.app.tar.gz.sig \
     dist-release/software-acceptance.md dist-release/Acceptance-Sign-P2S.3mf dist-release/Acceptance-Desk-Clip-P2S.3mf
   ```

   Attach the three update assets under exactly these names, because `latest.json` names the archive's URL.

   Publishing a release as **Latest** is what updates installed apps. Each installed app reads `https://github.com/AojdevStudio/materialize-3d/releases/latest/download/latest.json` at launch, and offers the update when that version is newer than its own. A draft or a prerelease never reaches installed apps. To hold a release back, publish it as a draft or prerelease, or leave the earlier release marked Latest until the download check below passes.

   The first release that contains the updater must still be installed by hand from its DMG. Only later releases arrive as updates.

6. Download the published DMG, checksum file, update assets, record, and approved exports from the actual release. Compare the downloaded DMG's full SHA-256 with the build checksum, published checksum file, release body, and acceptance record. Compare the downloaded archive's full SHA-256 with its build checksum. Compare the downloaded `latest.json` and `.sig` byte for byte with the files in `dist-release/`. Compare both downloaded 3MF hashes with their approved and exported hashes in the record. Then confirm that the Latest feed URL serves the same `latest.json`. Stop on any mismatch or missing attachment. Retain this published-download proof with the release evidence.

   ```bash
   mkdir -p dist-release/published && cd dist-release/published
   gh release download v0.2.1 -R AojdevStudio/materialize-3d
   shasum -a 256 Materialize-3D-0.2.1-macos-arm64.app.tar.gz
   cat ../Materialize-3D-0.2.1-macos-arm64.app.tar.gz.sha256
   cmp latest.json ../latest.json
   cmp Materialize-3D-0.2.1-macos-arm64.app.tar.gz.sig ../Materialize-3D-0.2.1-macos-arm64.app.tar.gz.sig
   curl -fsSL https://github.com/AojdevStudio/materialize-3d/releases/latest/download/latest.json | cmp - ../latest.json
   ```

   The last command passes only after the release is published as Latest.

## Required software acceptance record

The completed record is a publication gate. Attach it to the eventual release with accessible recordings, screenshots, and logs. Keep it outside tracked source so recording the final bytes cannot change their source commit. Do not publish with missing or failed required software checks. A rehearsal result cannot replace a final tagged DMG test.

Record the exact source tag and commit, DMG filename and full SHA-256, installed bundle version, helper identity and signing team, runtime pins and verification, and bundle inventory. Identify each machine, macOS version, chip, test account, isolation option, effective HOME and `PATH`, and whether that machine built the DMG. Keep headless fresh-account, installed-release wrapper, GUI, and independent-machine results separately labeled.

Include every result required by the [source release notes](releases/v0.2.1.md) and [installed GUI checklist](verify-on-mac.md). Retain exact OpenAI model IDs, prompts and follow-ups, tool results, revision IDs, geometry measurements, checks, warnings, approval hashes, export IDs, destinations, and full exported-file hashes. Include watchable direct human GUI approval and native Save evidence, Bambu Studio 02.08.02.61 P2S 0.4 mm import and slice proof, and each persistence, cancellation, interruption, failure, and successful recovery result. Report failures and unrun checks with reasons. Excluded candidates must not appear as accepted exports.

Copy the two accepted exports to the proposed distribution filenames without changing their bytes. Record those names and matching hashes. State all remaining limits. Physical acceptance remains pending until Ossie records an actual print and inspection. Only Ossie decides to print.

## Clean-install test

Label this evidence **headless fresh-account**. Keep it separate from installed GUI evidence and record whether the Mac also built the DMG.

`scripts/release/clean-install-test-macos.sh` installs the DMG the way a new person meets it, runs the CAD helper from the installed app, and has the app itself build the cable clip:

```bash
scripts/release/clean-install-test-macos.sh dist-release/Materialize-3D-0.2.1-macos-arm64.dmg
```

It creates a fresh standard account (not an admin, no password, so nobody can log in as it) and works as that account with an empty home and only the system `PATH`. The DMG lands in `~/Downloads` with the quarantine attribute a browser sets, Gatekeeper assesses the DMG and then the app copied into `~/Applications` (a standard account cannot write `/Applications`), `check-app-bundle.sh` checks the installed copy, and the bundled helper, still quarantined, verifies its runtime, boots both guests, and builds the cable clip from `cad-host/spike/cable-clip-fillet-first.py` into a closed mesh. Then the installed app, still quarantined, builds the same clip through its own `part` kind and pipeline (`materialize-3d --cad-self-test`): it verifies its bundled helper and runtime, runs both guests, checks the mesh and both requirements, slices with Bambu Studio, and keeps the STEP inside the package. Each step fails the run. The account and its home are deleted on exit, and the evidence stays in `~/m3d-verify/clean-install-<timestamp>/`. It needs macOS 26 or later, `sudo` without a password prompt, and a validated Bambu Studio the test account can run: in `/Applications`, or named by `BAMBU_STUDIO_CLI` at a path the account can read (for example under `/Users/Shared`).

What "clean" covers: an account that has never run, approved, or installed Materialize 3D, with no developer tools on its `PATH`, so nothing it owns can vouch for the app. What it does not cover: the Mac itself is shared. Gatekeeper's system-wide records (its assessment cache and any notarization ticket it has already fetched) belong to the machine, so a build that `build-macos.sh` already assessed on the same Mac is not new to Gatekeeper there. The Xcode command line tools are installed system-wide, which `check-app-bundle.sh` uses for `lipo`. The account never logs in at the console, so the app's own first-launch prompt and its window are not exercised; the helper runs from the shell. Run it on a Mac that did not build the DMG to take the build machine's records out of the picture.

## Verify the installed release

`scripts/release/verify-installed-macos.sh` installs the built DMG into `/Applications` on an Apple Silicon Mac and checks Gatekeeper and the staple, the signature, the schema 3 migration, MCP off without the setting, the app's own keychain item remaining unchanged with MCP listening after a relaunch, the MCP endpoint's 401 without a valid token, and a sign built over MCP with a seeded token that stays pending, because the endpoint refuses to approve and approval stays with a person in the app. Each of these fails the run when it does not hold. It records the bundle inventory for inspection; the build script enforces the exact bundle file list. It takes the DMG and a checkout that holds `docs/acceptance/` and the schema 3 fixture.

Label this evidence **installed-release wrapper, isolated HOME under existing console login**. The wrapper uses a fresh throwaway HOME and keychains, with a schema 3 fixture for migration. It creates no fresh account. Its shell adds developer directories to `PATH`, so it does not establish the system-only `PATH` required for GUI acceptance. Its migration, keychain, and MCP results do not prove OpenAI GUI acceptance or an independent-machine test.

```bash
scripts/release/verify-installed-macos.sh dist-release/Materialize-3D-0.2.1-macos-arm64.dmg .
```

It is designed to run unattended over SSH. Confirm that its desktop-session and credential prerequisites hold before running it. The body does not run in the calling shell: keychain unlock state belongs to a security session and the app runs in the logged-in user's desktop session, so the script bootstraps the body as a transient LaunchAgent in `gui/<uid>`, waits up to 15 minutes, streams the job log, and exits with the job's status. Someone must be logged in at the console; with no desktop session the script says so and stops instead of waiting.

Secrets stay out of `ps`. The throwaway keychain password is random per run, every `security` subcommand that takes a password is fed to `security -i` on stdin, and the MCP token reaches curl through a mode-600 header file. The run fails if securityd recorded a keychain prompt or if a new Terminal.app process appeared while it ran, and fails rather than waiting when the app, the MCP endpoint, or the job itself does not arrive in time.

Run it only when replacing the app in `/Applications` is intended: it refuses a running app, removes any existing copy, installs the DMG's app, and leaves that installed release in place. Personal app data stays in the real home directory; verification uses a throwaway home. On exit the DMG is detached, the test app is quit, the throwaway keychains and token header are deleted, and the real default keychain and search list are put back if needed. A successful run also requires that neither real keychain setting changed before teardown. The run directory, its evidence, and the job log remain under `~/m3d-verify/release-verify-<timestamp>/`.

## Complete installed GUI acceptance

Follow [Verify the installed Mac app](verify-on-mac.md) after the scripted checks. Its native verification section covers the signed CuaDriver route exercised on the mini. Use real input and native dialogs. Record a missing tool or permission as an unmet prerequisite rather than substituting the debug e2e endpoint.

A fresh standard account logged into a desktop is the strongest GUI isolation option. An isolated HOME and test keychain under an existing console login are a separate option. Label the GUI evidence with the option used. Neither an isolated HOME nor a fresh account proves an independent-machine test. Both GUI options require fresh app data, only the system `PATH`, and no checkout runtime dependencies or CAD cache.

A passing `--cad-self-test` proves a backend path through the installed binary. An MCP build proves the endpoint path. Neither proves OpenAI chat, the part detail, human approval, or the native Save dialog. `.agents/skills/verify-materialize-3d/scripts/mac.ts` launches an e2e debug bundle, not the release installed from the DMG.

The app must find its CAD helper and pinned runtime inside its installed bundle. Acceptance cannot depend on a source checkout, a developer Python environment, or a CAD cache. Preserve the bundle inventory and the runtime verification output with the GUI evidence.

Physical print validation is separate from this checklist. Use [Physically accept the P2S sign and desk clip](acceptance/p2s-sign-and-part.md) for the exact software-verified exports. A release never records a print result on a user's behalf.
