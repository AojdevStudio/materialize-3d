# Verify the installed Mac app

Use this checklist for 0.2.0 release acceptance. A pass requires the installed release to build both a sign and a general part through OpenAI chat, then export approved P2S 0.4 mm 3MFs through the GUI. This document is a recipe, not a record of a passing run.

For physical acceptance of the exact software-verified exports, use [Physically accept the P2S sign and desk clip](acceptance/p2s-sign-and-part.md). Use only actual approved exports and the software acceptance record attached to a published release. Physical acceptance remains pending until Ossie chooses to print and inspects the actual objects.

## Choose GUI isolation

Record one of these labels with the actual installed GUI evidence.

- **Fresh-account GUI**. Use a fresh standard account logged into a desktop. This is the strongest GUI isolation option. The headless clean-install wrapper's account never logs in, so its results do not prove this GUI path.
- **Isolated-HOME GUI under existing console login**. Use fresh app data and a throwaway test keychain in an isolated HOME under the existing desktop login. The installed-release wrapper demonstrates this HOME and keychain isolation for its scripted checks. It does not prove OpenAI chat or native dialogs. Use a new isolated HOME for GUI first-run acceptance, separate from the wrapper's migration fixture and MCP data.

Both options require the actual installed app with only the system `PATH`, `/usr/bin:/bin:/usr/sbin:/sbin`. Record the app's effective `PATH` and data location. The installed-release wrapper adds developer directories to its shell `PATH`, so its log alone cannot prove this requirement. Neither isolation label proves an independent-machine run. Record the machine separately, including whether it built the DMG.

Use the same launch method and test keychain after every quit or interruption. For fresh-account GUI, launch from Applications in the test user's Finder and verify the effective system-only `PATH`. For isolated-HOME GUI, do not launch through Finder. In the test desktop security session, set `M3D_GUI_HOME` to the recorded isolated home and launch the installed app with explicit environment values.

```bash
/usr/bin/open -n --env HOME="${M3D_GUI_HOME:?Set the recorded isolated home}" \
  --env PATH=/usr/bin:/bin:/usr/sbin:/sbin "/Applications/Materialize 3D.app"
```

For isolated-HOME GUI, keep the recorded test keychain setup active for each launch. Record and verify the effective HOME, PATH, and app data location after each restart. If they change, stop the check and restore the test environment before proceeding. Preserve the real account's keychain settings during setup and restore them during teardown.

## Prepare the installed release

1. Use an Apple Silicon Mac on macOS 26.0 or later with the desktop session required by your selected GUI isolation option.
2. Record the exact DMG filename, SHA-256, source commit, macOS version, and chip. Compare the DMG hash with its release checksum.
3. Follow the [install guide](install-macos.md). Copy the app from the DMG to Applications and eject the DMG. Preserve download quarantine for first-launch GUI acceptance. Use the launch method for your selected GUI isolation option above and record any macOS confirmation. The installed-release wrapper removes quarantine before launch, so its launch does not prove this step. If macOS shows no confirmation, record that observation and the machine's prior exposure to these bytes.
4. Confirm the installed bundle version is `0.2.0`. For an installation in `/Applications`, read it with this command.

   ```bash
   defaults read "/Applications/Materialize 3D.app/Contents/Info.plist" CFBundleShortVersionString
   ```

5. Confirm that the selected isolation option starts with fresh app data and a test keychain. Preserve existing user data and credentials. Record the installed app's path and confirm that no development copy is running.
6. Provide only the installed app, Bambu Studio 02.08.02.61, network access for OpenAI, and an API key. Confirm the system-only `PATH`. The app must supply its own CAD helper and pinned runtime. Keep source checkouts, developer tools, Python environments, and CAD caches out of the app's runtime inputs.
7. In **Settings > Bambu Studio**, confirm version `02.08.02.61` and the selected installation path. Install it alongside another version as the install guide describes.
8. In onboarding or **Settings > Agent**, select **OpenAI**, select an offered model, and save the API key through the app. Record the model ID. Confirm that the chat footer shows OpenAI and that model. Keep the key out of screenshots, recordings, and logs.
9. Leave the external MCP endpoint off for the chat test. Start a recording before the first chat request. Capture both the action and its resulting screen.

## Native verification tools

This recipe uses real input and macOS dialogs. A person can drive them directly. The signed `/Applications/CuaDriver.app` host also drove the installed release candidate on the mini. This establishes a native control route, not completed release acceptance.

Discover the installed driver's current contracts before automating a run.

```bash
M3D_DRIVER=/Applications/CuaDriver.app/Contents/MacOS/cua-driver
"$M3D_DRIVER" --help
"$M3D_DRIVER" describe get_window_state
"$M3D_DRIVER" describe click
"$M3D_DRIVER" describe start_recording
"$M3D_DRIVER" call check_permissions '{"prompt":false}'
```

Confirm that permission results identify the signed driver daemon. Accessibility and Screen Recording grants belong to that identity. A terminal or another automation tool can report different grants. Verify actual capture and input as well. Resolve any macOS direct-capture consent through its normal permission flow before recording.

Take a fresh snapshot of the exact app window before using its element tokens. Select a control by its label and supported action. A Bambu Studio wizard control can have role `AXStaticText` and still support `AXPress`. Its floating wizard can be absent from the driver's normal window list. When keyboard input reports `same_pid_keyboard_ambiguity`, use the dialog's supported AX actions rather than retrying process-level keyboard input.

Inspect the recordings before attaching them. Keep credentials and unrelated desktop content out of shared media. A consent overlay or another modal that hides the action does not prove an unobstructed flow. A permission status check, backend self-test, or debug endpoint cannot replace the installed GUI steps below.

## Build and export a sign through OpenAI

1. Start a new conversation. Send this exact request.

   ```text
   Make a 150 x 210 mm door sign that says BACK SHORTLY in navy on white with a teal rule under it. Build it for a Bambu Lab P2S with a 0.4 mm nozzle.
   ```

2. Wait for the tool call to finish. Capture the OpenAI reply, build progress, completed check results, and the revision opened in the Signs view. An error or text-only design proposal is not a completed build.
3. Review the preview, every check, and the materials. Confirm that the build is verified, approval is pending, and Print-tested is Not tested. Record the revision ID and full package SHA-256.
4. Click **Approve** for that revision and hash. Confirm that approval names the same hash. The assistant cannot approve it.
5. Click **Export 3MF**. Use the native Save dialog to save `sign-openai.3mf` in a new acceptance folder. Record the actual destination.
6. Hash the exported file. Replace the example folder below with the folder you used.

   ```bash
   shasum -a 256 ~/Desktop/m3d-acceptance/sign-openai.3mf
   ```

7. Compare the digest with the approved package hash. Record both full values. They must match.
8. Open that exported file as a project in Bambu Studio 02.08.02.61. Keep its project settings. Confirm P2S, a 0.4 mm nozzle, the requested dimensions, one face-down sign, and white, navy, and teal materials. Slice it and inspect all three colors on the first layer. Save a screenshot of the profile and sliced plate.

## Build and export a general part through OpenAI

Use a new conversation so the sign's dimensions do not carry over. The dimensions below come from `src-tauri/tests/fixtures/parts/specs.json`, entry `cable-clip`. The assistant must generate the part through chat. Do not import that fixture to replace the chat step.

1. Send this exact request.

   ```text
   Build a six-cable USB-C desk clip for a Bambu Lab P2S with a 0.4 mm nozzle. Use six 4.4 mm cable grooves, an 18.4 mm desk jaw opening, 60 mm overall width, 25 mm depth, walls at least 3 mm thick, and 1.2 mm fillets. Keep at least 3 mm of material outside each end groove. Measure width, depth, and jaw opening within 0.2 mm of their requested values. Use one filament. Orient the part on a flat side so it prints without supports. Show the checks and any print warnings.
   ```

2. Wait for the real CAD build and slice to finish. Record the full prompt, selected model, tool result, revision ID, check counts, and build duration. If the runtime is unavailable, record the failure. Do not supply a development runtime or replace the run with a backend test.
3. Open the part in the Signs view. Confirm that the part detail shows a rendered view, revision buttons, and measured requirements. Use **Show all checks** to inspect the complete results. Capture the width, jaw opening, and any failed checks or advisory warnings.
4. Compare the rendered geometry and measured mesh or STEP with every requested constraint. Check 60 mm width, 25 mm depth, an 18.4 mm jaw, six 4.4 mm grooves, 1.2 mm fillets, and at least 3 mm walls and outer groove margins. Record the measurement axes after rotation. Require a flat contact face and support-free orientation in the app's package. Selected passing measurements alone do not establish the other dimensions. If a dimension or print orientation fails, ask OpenAI to revise the part before approval. Warning acknowledgement does not correct geometry or supply supports.
5. Confirm that blocking checks pass and Print-tested is Not tested. Review every warning. Record the full package hash from the revision's stored artifacts with the read-only query below. A shortened hash on the button is not enough for the file comparison.
6. Click **Approve**. When warnings exist, confirm that the approved state records the same warnings. Click **Export 3MF** and save `part-openai.3mf` through the native Save dialog.
7. Hash the exported file with `shasum -a 256`. Compare its full digest with the approved package hash and record both.
8. Open the exported 3MF as a project in Bambu Studio 02.08.02.61. Keep the project settings. Confirm P2S, the 0.4 mm nozzle, the requested dimensions, the filament mapping, and the support-free placement. Slice and save a screenshot. Do not rotate the part or change supports in Bambu to correct the accepted export. A required correction must produce a new app revision, approval, and export. Do not send a print job for this software acceptance step.
9. Ask the assistant for a revision. Capture the new revision in the part detail and confirm that the earlier revision remains accessible. Confirm that the new revision awaits approval and cannot export before its own GUI approval. Approval must apply to the exact revision and package being exported.

## Check persistence and failure handling

1. Quit with Cmd-Q and reopen the same installed copy with your selected isolation option's launch method. Preserve the same test HOME, keychain, and system-only PATH. Confirm that the OpenAI provider, model, stored-key state, conversations, revisions, and approvals persist. Reopening must not start another build.
2. Start another build through chat and click **Stop** while it runs. Record the cancelled tool result and failed revision. An unfinished revision must not become approvable.
3. Start another build, quit while it runs, and reopen with that same launch method and test environment. Record the interrupted state. Confirm that no build restarts on its own.
4. Reuse an identical spec through the build tool and confirm that it reuses the verified build. Repeating natural-language chat alone does not prove reuse, because the model can generate a different spec. Keep this as a separate backend or MCP check if the GUI cannot reproduce an identical spec.

Exercise these failures separately. Record the actual error, its recovery action, and a successful build after recovery. Do not count a failed revision tab or an assistant's summary as proof of the underlying failure.

- **Invalid OpenAI credentials**. In the isolated test environment, save an invalid test key through Settings and submit a chat request. Capture the authentication error without exposing a real key. Restore the valid key privately through Settings and confirm that chat can build again.
- **Unavailable Bambu Studio**. Launch the installed app in the test environment with `BAMBU_STUDIO_CLI` set to a recorded nonexistent path. This supported override takes precedence over both Settings and discovered installations. Start a GUI chat build and capture the error and its instruction to choose Bambu Studio in Settings. Do not move or delete a real installation. Quit, remove the test override, relaunch with the same HOME, test keychain, and system-only PATH, select the validated installation through Settings, and confirm that a build succeeds.
- **CAD execution failure**. Through chat, request a deliberate, bounded CAD execution error in a separate test design. Retain the actual failed build tool result and CAD stage error. Confirm that the failed artifact cannot be approved or exported. Ask OpenAI to repair it and record the successful new revision. Automatic repair counts only when the failed execution and later successful build are both recorded. A measurement failure or scripted model response does not prove a real CAD execution failure.

## Read the full hashes

For the default data location, run this read-only query as the test user after GUI export. It lists the revision, build hash, approved hash, acknowledged warnings, exported path, and export hash. Match the row to the revision and destination used above. If the app uses a different data location, record and use that path.

```bash
sqlite3 -readonly -header -column "$HOME/Library/Application Support/com.aojdevstudio.materialize3d/materialize.db" \
  "SELECT r.id, r.kind, r.title, r.number, b.build_status, json_extract(b.artifacts_json, '$.package_sha256') AS build_sha256, r.approved_package_sha256, r.acknowledged_warnings_json, e.path, e.sha256 AS export_sha256 FROM revisions r JOIN builds b ON b.id = r.build_id LEFT JOIN revision_exports e ON e.revision_id = r.id AND e.format = 'print_package' ORDER BY r.created_at, e.exported_at;"
```

Compare the approved hash, the export record's hash, and the `shasum` output for each file. All three must match. This read does not approve or export anything. The GUI actions remain the acceptance path.

## Record the evidence

Keep one evidence record for the exact installed DMG. Include these results.

- DMG filename, checksum, source commit, installed path and version, macOS version, chip, and Bambu Studio path and version.
- GUI isolation label, console account, app data location, effective `PATH`, and whether this Mac built the DMG. Keep headless fresh-account and installed-release wrapper evidence separately labeled.
- OpenAI model ID and both exact chat requests. Include any follow-up prompts or errors.
- A watchable recording of chat, review, approval, and native Save for both objects. Include screenshots of the part's measured requirements and warnings.
- Both exported 3MFs, revision IDs, approved package hashes, exported-file hashes, and Bambu Studio import and slice screenshots.
- Relaunch, cancellation, interruption, and all three failure recovery results. Label each pass, fail, or not run with its reason.
- A statement of whether a physical print was attempted. Keep physical results separate from geometry, slicing, and GUI results.

Build artifacts live under `~/Library/Application Support/com.aojdevstudio.materialize3d/signs/<build id>/`. Use the revision's `build_id` to locate its package, spec, checks, and slice output. Read the revision and export records for full approval and export hashes. Preserve that evidence before removing a test account.

## Separate development and backend checks

The [verification skill](../.agents/skills/verify-materialize-3d/SKILL.md) describes the Linux debug app and the macOS `--features e2e` debug build. `.agents/skills/verify-materialize-3d/scripts/mac.ts` controls that debug build through its test endpoint and scripted dialogs. The release binary omits that endpoint and dialog override. A `mac.ts` run does not verify the installed release.

The [release procedure](releasing.md) describes bundle, clean-account, migration, keychain, MCP, and CAD self-tests. Those checks support acceptance but do not exercise OpenAI chat, human approval, or the native Save dialog. A plain `bun tauri build --bundles app` also does not assemble the signed CAD helper and runtime required by the release.
