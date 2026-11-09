# Verify the installed Mac app

Use this checklist for release acceptance. A pass requires the installed release to make a part through the studio's chat and slice it to a P2S 0.4 mm 3MF. This document is a recipe, not a record of a passing run.

## Choose GUI isolation

Record one of these labels with the actual installed GUI evidence.

- **Fresh-account GUI**. Use a fresh standard account logged into a desktop. This is the strongest GUI isolation option. The headless clean-install wrapper's account never logs in, so its results do not prove this GUI path.
- **Isolated-HOME GUI under existing console login**. Use fresh app data and a throwaway test keychain in an isolated HOME under the existing desktop login. Use a new isolated HOME for GUI first-run acceptance.

Both options require the actual installed app with only the system `PATH`, `/usr/bin:/bin:/usr/sbin:/sbin`. Record the app's effective `PATH` and data location. Neither isolation label proves an independent-machine run. Record the machine separately, including whether it built the DMG.

Use the same launch method and test keychain after every quit or interruption. For fresh-account GUI, launch from Applications in the test user's Finder and verify the effective system-only `PATH`. For isolated-HOME GUI, do not launch through Finder. In the test desktop security session, set `M3D_GUI_HOME` to the recorded isolated home and launch the installed app with explicit environment values.

```bash
/usr/bin/open -n --env HOME="${M3D_GUI_HOME:?Set the recorded isolated home}" \
  --env PATH=/usr/bin:/bin:/usr/sbin:/sbin "/Applications/Materialize 3D.app"
```

For isolated-HOME GUI, keep the recorded test keychain setup active for each launch. Record and verify the effective HOME, PATH, and app data location after each restart. If they change, stop the check and restore the test environment before proceeding. Preserve the real account's keychain settings during setup and restore them during teardown.

## Prepare the installed release

1. Use an Apple Silicon Mac on macOS 26.0 or later with the desktop session required by your selected GUI isolation option.
2. Record the exact DMG filename, SHA-256, source commit, macOS version, and chip. Compare the DMG hash with its release checksum.
3. Follow the [install guide](install-macos.md). Copy the app from the DMG to Applications and eject the DMG. Preserve download quarantine for first-launch GUI acceptance. Use the launch method for your selected GUI isolation option above and record any macOS confirmation. If macOS shows no confirmation, record that observation and the machine's prior exposure to these bytes.
4. Confirm the installed bundle version matches the release. For an installation in `/Applications`, read it with this command.

   ```bash
   defaults read "/Applications/Materialize 3D.app/Contents/Info.plist" CFBundleShortVersionString
   ```

5. Confirm that the selected isolation option starts with fresh app data and a test keychain. Preserve existing user data and credentials. Record the installed app's path and confirm that no development copy is running.
6. Provide only the installed app, Bambu Studio 02.08.02.61, uv with a Python it can run, network access, and an inference login. Confirm the system-only `PATH`. Keep source checkouts and developer tools out of the app's runtime inputs. The agent finds uv in the app's own `~/.local/bin` (`commandEnv` in `sidecar/src/agent.ts`), so for isolated-HOME GUI install it there: `HOME="$M3D_GUI_HOME" sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'`, then `HOME="$M3D_GUI_HOME" "$M3D_GUI_HOME/.local/bin/uv" python install`.
7. Start a recording before the first chat request. Capture both the action and its resulting screen. Keep the login out of screenshots, recordings, and logs.

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

Inspect the recordings before attaching them. Keep credentials and unrelated desktop content out of shared media. A consent overlay or another modal that hides the action does not prove an unobstructed flow. A permission status check or debug endpoint cannot replace the installed GUI steps below.

## Make and slice a part

1. On the start screen, the readiness banner names what the agent lacks. Sign in through its own control, and install uv or a Python for it if the banner asks. Send stays off until nothing is missing. Record the provider you signed in to.
2. Send this exact request. Record the model ID that the chat shows.

   ```text
   Make a 20 mm calibration cube and slice it to a 3MF for the P2S.
   ```

3. Wait for the turn to finish. Capture each tool step, the preview, and the file cards. An error or a text-only answer is not a finished part.
4. Open the Files tab. Confirm that a 3MF is listed under Print files. Record its path in the project folder, `~/Documents/Materialize 3D/<project>/`.
5. Click **Reveal in Finder** and copy the 3MF's absolute path. For isolated-HOME GUI it is under `$M3D_GUI_HOME/Documents/Materialize 3D/`, not under the console user's `~`. Hash that path with `shasum -a 256` and record the full digest. Confirm that it holds `Metadata/plate_1.gcode` and `Metadata/slice_info.config` with `unzip -l`.
6. Click **Open in Bambu Studio**. Confirm that Bambu Studio 02.08.02.61 opens the file with the P2S and a 0.4 mm nozzle. Do not send a print job for this software acceptance step.

## Check persistence and failure handling

1. Type a new request on the start screen and do not send it. Quit with Cmd-Q and reopen the same installed copy with your selected isolation option's launch method. Preserve the same test HOME, keychain, and system-only PATH. Confirm that the draft, the earlier project and its chat, and the login persist.
2. Send a request and quit while the turn runs. Reopen with the same launch method. Confirm that the turn goes on from its last committed step, and that a step that finished does not run twice.
3. Quit the app. Launch it with `BAMBU_STUDIO_CLI` set to a recorded nonexistent path: `/usr/bin/open -n --env BAMBU_STUDIO_CLI=/nonexistent/BambuStudio --env HOME=... --env PATH=/usr/bin:/bin:/usr/sbin:/sbin "/Applications/Materialize 3D.app"`, with the same HOME the selected isolation option uses. A Finder launch does not read a variable exported in Terminal, so use this launch for the check in either option. Ask for a slice. Capture the error the turn reports. Do not move or delete a real installation. Quit, relaunch without the override, and confirm that a slice succeeds.

## Record the evidence

Keep one evidence record for the exact installed DMG. Include these results.

- DMG filename, checksum, source commit, installed path and version, macOS version, chip, and Bambu Studio path and version.
- GUI isolation label, console account, app data location, effective `PATH`, and whether this Mac built the DMG. Keep headless wrapper evidence separately labeled.
- The provider, the model, and the exact chat request. Include any follow-up prompts or errors.
- A watchable recording of the chat, the preview, and Open in Bambu Studio.
- The 3MF's path and full SHA-256, and the Bambu Studio screenshot.
- Relaunch, interruption, and failure recovery results. Label each pass, fail, or not run with its reason.

## Separate development and backend checks

The [verification skill](../.agents/skills/verify-materialize-3d/SKILL.md) describes the Linux debug app and the macOS `--features e2e` debug build. `.agents/skills/verify-materialize-3d/scripts/mac.ts` controls that debug build through its test endpoint and scripted dialogs. The release binary omits that endpoint and dialog override. A `mac.ts` run does not verify the installed release.

The [release procedure](releasing.md) describes the bundle check and the clean-account CAD self-test. Those checks support acceptance but do not exercise chat or the slice.
