# Verify the sign workflow on a Mac

For the printed acceptance test, follow `docs/acceptance/p2s-test-sign.md` instead; it uses a smaller sign.

Follow these steps to confirm the conversational sign workflow on macOS: a chat request builds a verified sign, a person approves the exact file, the approved file exports unchanged, and restarts never repeat work. Allow about 20 minutes.

## Before you start

1. Install Bambu Studio 02.08.02.61. The app refuses other versions. Check the installed version:

   ```bash
   defaults read /Applications/BambuStudio.app/Contents/Info.plist CFBundleShortVersionString
   ```

   If it is not `02.08.02.61`, install that release next to the existing one (for example in `~/Applications/BambuStudio-02.08.02.61/`) and point the app at it:

   ```bash
   export BAMBU_STUDIO_CLI="$HOME/Applications/BambuStudio-02.08.02.61/BambuStudio.app/Contents/MacOS/BambuStudio"
   ```

2. Install Rust (`rustup`), Bun, and the Xcode command line tools.
3. Have an OpenAI or Anthropic API key. Claude Pro/Max sign-in is not offered.

## Get the app

Use the reviewed release build from the handoff (a zipped `Materialize 3D.app`, with its commit and SHA-256), or build the same commit yourself:

```bash
git fetch origin
git switch --detach <reviewed commit>
bun install --frozen-lockfile
bun tauri build --bundles app
open "src-tauri/target/release/bundle/macos/Materialize 3D.app"
```

The release build contains no verification harness. The first Rust build takes several minutes.

## Steps

1. Finish onboarding. On the AI provider step, choose OpenAI or Anthropic and paste your key, or skip and add it later in Settings under Agent.
2. In the AI Assistant panel, send: `Make a 150 x 210 mm door sign that says BACK SHORTLY in navy on white with a teal rule under it.`
   - You see `build_sign` with five steps: Spec validated, Geometry built, Package written, Sliced, Verified.
   - The result reads `Verified N of N checks`, with every check passing, and `Awaiting your approval (the assistant cannot approve)`.
   - The Signs view opens on the new revision.
3. In the Signs view, review the preview and the checks. Confirm the three rows are separate: Sliced and verified is Yes, Print-tested is Not tested, Approval is Pending for a hash.
4. Click `Approve r1 for …`. Approval now reads Approved for the same hash.
5. Click `Export 3MF` and save the file. Confirm the exported file is the approved one:

   ```bash
   shasum -a 256 ~/Desktop/<exported-file>.3mf
   ```

   The digest matches the package hash shown in the Signs view.
6. Quit with Cmd-Q and relaunch. The chat history, the stored key, and the approval are all still there.
7. Cancel test. Ask for another sign, then click Stop while the steps run. The card reads `Cancelled after N of 5 steps`, and the Signs list shows that revision as failed with `build cancelled`.
8. Restart test. Ask for another sign and press Cmd-Q while the steps run. Relaunch. The card reads `Interrupted, the app closed while it ran`, the revision is failed with `interrupted`, and nothing starts building again.
9. Idempotency test. Send the request from step 2 again. The result reuses revision r1 instead of creating a duplicate.

## Optional: external agent through MCP

1. Open Settings, then External agents, and turn on the local MCP endpoint.
2. Click `Copy Claude Code command` and run it in a terminal.
3. In Claude Code, ask it to list your signs, then to build one. The new revision appears in the Signs view as Pending. Claude Code has no tool that can approve it.

## Optional: open the approved file in Bambu Studio

Open the exported 3MF in Bambu Studio as a project and keep its settings. The plate shows one sign, face down, with white, navy, and teal assigned to slots 1 to 3. Slicing shows all three colors on the first layer.

## Physical print

CI and the steps above prove a verified slice. They do not prove a print. Print an approved revision, then record the outcome in the Signs view with `Record print result`. Print-tested changes only when a person records it.

## Where the files are

Each revision lives in `~/Library/Application Support/com.aojdevstudio.materialize3d/signs/<revision id>/`: `sign.3mf` (read-only), `preview.png`, `spec.json`, `checks.json`, and `slice/` with the G-code, `result.json`, `effective-settings.json`, and Bambu's logs.

## Automated checks you can run

```bash
cd src-tauri
cargo test --lib
cargo test --lib fabrication::build -- --ignored --nocapture --test-threads=1
```

The second command builds, slices, and verifies a synthetic sign with your Bambu Studio and prints every check.
