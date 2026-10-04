# Release Materialize 3D for macOS

Releases are built on an Apple Silicon Mac by `scripts/release/build-macos.sh`, outside GitHub Actions. Signing and notarization credentials never reach a pull request job.

## What you need

- An Apple Silicon Mac on macOS 26 or later with Xcode command line tools, Bun, and Rust. The app requires macOS 26.0.
- A keychain that holds a Developer ID Application identity, and its password.
- An App Store Connect API key for `notarytool`: key id, issuer id, and the `.p8` content.
- The arm64 CAD runtime for the tagged commit: the `cad-runtime-arm64` artifact of that commit's `CAD runtime` workflow run, or the output of `cad-runtime/build.sh arm64` on a Linux machine with Docker, buildx, and arm64 binfmt. Either way it must match `cad-runtime/pins-arm64.json`, which the CAD helper compiles in.

## Steps

1. Set the same version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, and land that change through a pull request.
2. Tag the merged commit on `main` and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag v0.1.0 && git push origin v0.1.0
   ```

3. In a clean checkout of the tag, export the credentials and the runtime's location, and run the script:

   ```bash
   export RELEASE_KEYCHAIN=~/Library/Keychains/<release>.keychain-db
   export RELEASE_KEYCHAIN_PASSWORD=... APPLE_API_KEY_ID=... APPLE_API_ISSUER_ID=... APPLE_API_PRIVATE_KEY="$(cat AuthKey.p8)"
   export CAD_RUNTIME_DIR=~/cad-runtime-arm64   # holds Image, rootfs.img, job.img
   scripts/release/build-macos.sh
   ```

   The script refuses a dirty tree, an untagged commit, mismatched versions, or a CAD runtime that does not match the helper's pins. It builds the CAD helper from `cad-host/` and places it at `Contents/MacOS/materialize-cad-host`, with the runtime at `Contents/Resources/cad-runtime/{Image,rootfs.img,job.img}`. It signs the helper first, with the hardened runtime and the virtualization entitlement, then the app around it, and notarizes and staples both the app and the DMG; the app's staple covers the helper. Then it checks Gatekeeper acceptance, the architecture, the absence of the e2e harness and of build-machine paths in both executables, and runs `scripts/release/check-app-bundle.sh`: the exact file list of the app bundle, macOS 26.0 as the minimum, the helper's signature and its only entitlement, and the bundled runtime against the helper's pins. It writes `dist-release/Materialize-3D-<version>-macos-arm64.dmg` and a `.sha256` file.

4. Run the clean-install test on the DMG (below), then install the DMG on a Mac and run through `docs/install-macos.md` before publishing.
5. Write the release notes in `docs/releases/v<version>.md`, land them with the version change, and publish the release with the DMG and its checksum:

   ```bash
   gh release create v0.1.0 --title "Materialize 3D 0.1.0" --notes-file docs/releases/v0.1.0.md \
     dist-release/Materialize-3D-0.1.0-macos-arm64.dmg dist-release/Materialize-3D-0.1.0-macos-arm64.dmg.sha256
   ```

## Clean-install test

`scripts/release/clean-install-test-macos.sh` installs the DMG the way a new person meets it and runs the CAD helper from the installed app:

```bash
scripts/release/clean-install-test-macos.sh dist-release/Materialize-3D-0.1.0-macos-arm64.dmg
```

It creates a fresh standard account (not an admin, no password, so nobody can log in as it) and works as that account with an empty home and only the system `PATH`. The DMG lands in `~/Downloads` with the quarantine attribute a browser sets, Gatekeeper assesses the DMG and then the app copied into `~/Applications` (a standard account cannot write `/Applications`), `check-app-bundle.sh` checks the installed copy, and the bundled helper, still quarantined, verifies its runtime, boots both guests, and builds the cable clip from `cad-host/spike/cable-clip-fillet-first.py` into a closed mesh. Each step fails the run. The account and its home are deleted on exit, and the evidence stays in `~/m3d-verify/clean-install-<timestamp>/`. It needs macOS 26 or later and `sudo` without a password prompt.

What "clean" covers: an account that has never run, approved, or installed Materialize 3D, with no developer tools on its `PATH`, so nothing it owns can vouch for the app. What it does not cover: the Mac itself is shared. Gatekeeper's system-wide records (its assessment cache and any notarization ticket it has already fetched) belong to the machine, so a build that `build-macos.sh` already assessed on the same Mac is not new to Gatekeeper there. The Xcode command line tools are installed system-wide, which `check-app-bundle.sh` uses for `lipo`. The account never logs in at the console, so the app's own first-launch prompt and its window are not exercised; the helper runs from the shell. Run it on a Mac that did not build the DMG to take the build machine's records out of the picture.

## Verify the installed release

`scripts/release/verify-installed-macos.sh` installs the built DMG into `/Applications` on an Apple Silicon Mac and checks it the way a new user meets it: Gatekeeper and the staple, the signature, the schema 3 migration, MCP off without the setting, the app's own keychain item remaining unchanged with MCP listening after a relaunch, the MCP endpoint's 401 without a valid token, and a sign built over MCP with a seeded token that stays pending, because the endpoint refuses to approve and approval stays with a person in the app. Each of these fails the run when it does not hold. It records the bundle inventory for inspection; the build script enforces the exact bundle file list. It takes the DMG and a checkout that holds `docs/acceptance/` and the schema 3 fixture.

```bash
scripts/release/verify-installed-macos.sh dist-release/Materialize-3D-0.1.0-macos-arm64.dmg .
```

It runs unattended, so it is safe over SSH. The body does not run in the calling shell: keychain unlock state belongs to a security session and the app runs in the logged-in user's desktop session, so the script bootstraps the body as a transient LaunchAgent in `gui/<uid>`, waits up to 15 minutes, streams the job log, and exits with the job's status. Someone must be logged in at the console; with no desktop session the script says so and stops instead of waiting.

Secrets stay out of `ps`. The throwaway keychain password is random per run, every `security` subcommand that takes a password is fed to `security -i` on stdin, and the MCP token reaches curl through a mode-600 header file. The run fails if securityd recorded a keychain prompt or if a new Terminal.app process appeared while it ran, and fails rather than waiting when the app, the MCP endpoint, or the job itself does not arrive in time.

Run it only when replacing the app in `/Applications` is intended: it refuses a running app, removes any existing copy, installs the DMG's app, and leaves that installed release in place. Personal app data stays in the real home directory; verification uses a throwaway home. On exit the DMG is detached, the test app is quit, the throwaway keychains and token header are deleted, and the real default keychain and search list are put back if needed. A successful run also requires that neither real keychain setting changed before teardown. The run directory, its evidence, and the job log remain under `~/m3d-verify/release-verify-<timestamp>/`.

Physical print validation is separate from this checklist. A release never records a print result.
