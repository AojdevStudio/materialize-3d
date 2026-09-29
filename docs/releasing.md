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
5. Write the release notes in `docs/releases/v<version>.md`, land them with the version change, and publish the release with the DMG and its checksum:

   ```bash
   gh release create v0.1.0 --title "Materialize 3D 0.1.0" --notes-file docs/releases/v0.1.0.md \
     dist-release/Materialize-3D-0.1.0-macos-arm64.dmg dist-release/Materialize-3D-0.1.0-macos-arm64.dmg.sha256
   ```

## Verify the installed release

`scripts/release/verify-installed-macos.sh` installs the built DMG into `/Applications` on an Apple Silicon Mac and checks it the way a new user meets it: Gatekeeper and the staple, the signature, the schema 3 migration, MCP off without the setting, the app's own keychain item remaining unchanged with MCP listening after a relaunch, the MCP endpoint's 401 without a valid token, and a sign built over MCP with a seeded token that stays pending, because the endpoint refuses to approve and approval stays with a person in the app. Each of these fails the run when it does not hold. It records the bundle inventory for inspection; the build script enforces the exact bundle file list. It takes the DMG and a checkout that holds `docs/acceptance/` and the schema 3 fixture.

```bash
scripts/release/verify-installed-macos.sh dist-release/Materialize-3D-0.1.0-macos-arm64.dmg .
```

It runs unattended, so it is safe over SSH. The body does not run in the calling shell: keychain unlock state belongs to a security session and the app runs in the logged-in user's desktop session, so the script bootstraps the body as a transient LaunchAgent in `gui/<uid>`, waits up to 15 minutes, streams the job log, and exits with the job's status. Someone must be logged in at the console; with no desktop session the script says so and stops instead of waiting.

Secrets stay out of `ps`. The throwaway keychain password is random per run, every `security` subcommand that takes a password is fed to `security -i` on stdin, and the MCP token reaches curl through a mode-600 header file. The run fails if securityd recorded a keychain prompt or if a new Terminal.app process appeared while it ran, and fails rather than waiting when the app, the MCP endpoint, or the job itself does not arrive in time.

Run it only when replacing the app in `/Applications` is intended: it refuses a running app, removes any existing copy, installs the DMG's app, and leaves that installed release in place. Personal app data stays in the real home directory; verification uses a throwaway home. On exit the DMG is detached, the test app is quit, the throwaway keychains and token header are deleted, and the real default keychain and search list are put back if needed. A successful run also requires that neither real keychain setting changed before teardown. The run directory, its evidence, and the job log remain under `~/m3d-verify/release-verify-<timestamp>/`.

Physical print validation is separate from this checklist. A release never records a print result.
