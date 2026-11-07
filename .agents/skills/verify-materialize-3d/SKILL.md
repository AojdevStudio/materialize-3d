---
name: verify-materialize-3d
description: Launch and drive the real Materialize 3D Tauri desktop app (React UI + Rust backend) on Linux through WebDriver, and capture screenshots, video, and SQLite side effects as proof. Use when asked to verify, demo, screenshot, or record a Materialize 3D UI flow, or to prove a PR's user-visible change per the AGENTS.md proof policy.
---

# Verify Materialize 3D

This skill drives the actual desktop app: the debug Rust binary with the real backend, rendered by WebKitGTK on a private Xvfb display, controlled through `tauri-driver` → `WebKitWebDriver`. The browser IPC mock in `src/dev/tauriBrowserMock.ts` never installs here, because the real window has `__TAURI_INTERNALS__`.

For installed macOS release acceptance, follow [Verify the installed Mac app](../../../docs/verify-on-mac.md). It requires OpenAI chat for a sign and a part, human approval, native Save dialogs, full hash comparison, and Bambu Studio P2S 0.4 mm import. Keep debug app evidence separate from release evidence.

## Where it runs

Run on the Linux host, dev-substrate (`ssh ossie@dev-substrate`, Ubuntu 24.04.5). It needs Xvfb, `WebKitWebDriver`, `tauri-driver` (`~/.cargo/bin`), xdotool, ffmpeg, `keyctl`, `dbus-run-session`, and `gnome-keyring-daemon`. Use Bun 1.4.4, the version CI pins in `.github/workflows/ci.yml`. `m3d.sh up` refuses to start on a host that is missing any of them, names every missing tool in one line, and creates nothing.

aojdevlinux, the Arch/Omarchy workstation, cannot run the app harness. Arch's `webkit2gtk-4.1` package ships no `WebKitWebDriver`, Xvfb (`xorg-server-xvfb`) is not installed and needs sudo, `tauri-driver` is not installed, and there is no passwordless sudo. There, `up` prints `m3d: missing Xvfb tauri-driver WebKitWebDriver; this host cannot run verification (use the Linux host)` and exits 1 **(observed 2026-11-03)**. From aojdevlinux, drive dev-substrate over ssh. Put each phase in a script, `scp` it to dev-substrate, and run it with `ssh ossie@dev-substrate 'bash -l <script>'`, because nested quotes in an ssh command line break.

To verify work that lives on another machine, get the same tree onto the Linux host. Either push the branch and `git worktree add ~/m3d-<topic> <branch>`, or `rsync -a --exclude node_modules --exclude src-tauri/target <tree>/ ossie@dev-substrate:m3d-<topic>/`. Run every command below from that checkout's root.

Only one run per host. Vite's port 1420 is fixed by `vite.config.ts` (`strictPort`) and by `devUrl` in `tauri.conf.json`. `up` refuses when 1420, 4444, or 4445 is already bound. Never drive an instance you did not start, and never run `down` on one.

Other agents share this host. Hold `~/m3d-ui.lock` for the whole run, from `up` through `down`, so two runs never fight over the ports or the `current` link. Put the run in one script and start it with `flock -w 1800 ~/m3d-ui.lock bash <script>`, or open the lock in the script with `exec 9>~/m3d-ui.lock` and `flock -w 1800 9`. `flock -n ~/m3d-ui.lock true` tells you whether the lock is free. A held lock means another run is live, so wait for it instead of stopping it.

## Launch

```bash
S=.agents/skills/verify-materialize-3d/scripts
$S/m3d.sh up                 # deps, cargo build, Xvfb, Vite, tauri-driver; prints run dir
$S/wd.ts session             # launches the app window; prints the session id
$S/wd.ts wait '[data-testid=start-screen]' 30000   # the studio; see features/studio.md
$S/m3d.sh close-inspector    # debug builds dock devtools over the bottom 300px
```

`up` is ready when it prints `m3d: ready run=... display=:9N rev=<sha>`. A first cargo build takes a few minutes; later builds are incremental. Each run gets `~/m3d-verify/<timestamp>/`, and `~/m3d-verify/current` points at the active run.

`up` isolates app state with `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` under the run dir. A fresh run therefore starts at the studio start screen with no projects and an empty DB at `<run>/xdg/data/com.aojdevstudio.materialize3d/materialize.db`. `wd.ts end` followed by `wd.ts session` relaunches the app on the same data, which is how you prove persistence.

The driver and app run with the run directory as their working directory, so stray output never lands in the checkout. The app's Bambu Studio `--help` probe runs in its own temporary directory (PR 42), so neither the run directory nor the checkout gets a `result.json` **(observed 2026-11-03)**. Compare `git status --short` before `up` and after `down` to check for Git-visible changes. Ignored build and dependency outputs, including `src-tauri/target` and `node_modules`, stay in the checkout.

If the same verification needs to span several shell calls, hold the lock in a process you can stop as a unit. `flock ~/m3d-ui.lock sleep N &` started under `setsid` leaves the `sleep` holding the lock after you kill `flock`, so stop the `sleep` too and confirm with `flock -n ~/m3d-ui.lock true`.

`up` launches tauri-driver and the app on a private D-Bus session with its own Secret Service. Its disposable collection lives under the run's `xdg/data`, uses an empty password, and is removed by `down`. The run directory is accessible only to its owner. Use test credentials for these runs. The operator's desktop keyring is not used. A separate kernel session remains for comparisons with older builds that used keyutils.

Set `M3D_DISPLAY=:99` before `up` to reuse the long-lived devdesk Xvfb. `up` then starts no display of its own and `down` leaves `:99` running.

Why not `bun tauri dev` or `bun tauri build`? `tauri dev` attaches the app to the terminal and cannot be handed to WebDriver. The skill runs the development pieces directly: Vite on :1420 plus the debug binary that `cargo build` produces, which loads `devUrl`.

## Doctor

```bash
$S/m3d.sh doctor
```

This is a read-only check. It verifies that the checkout HEAD matches the built revision, that the binary exists, and that our Xvfb, Vite, and tauri-driver processes are alive and answering. It also checks that the WebDriver session answers and that the app DB lives inside the run dir. Run it first whenever anything looks off. A `FAIL` on the revision line means the build is stale: run `down`, then `up`.

## Drive

`wd.ts` is a plain W3C WebDriver client. Selectors are CSS by default, `xpath=<expr>` for XPath, and `text=<label>` for the innermost element whose text is exactly `<label>`.

```bash
$S/wd.ts click "button[aria-label=Settings]"
$S/wd.ts wait "[role=dialog][aria-label=Settings]"
$S/wd.ts click 'xpath=//div[@role="dialog"]//label[contains(., "Quality")]//option[@value="0.16"]'   # choose a <select> option
$S/wd.ts hover 'xpath=//li[.//button[@aria-label="Delete T1"]]'   # reveal a hover-only control in its own row
$S/wd.ts type "[data-testid=input-host]" "10.0.0.5" --clear
$S/wd.ts type "[data-testid=agent-base-url]" '' --clear   # clear only
KEY=... $S/wd.ts type-secret "[data-testid=agent-api-key]" KEY --clear   # types $KEY; actions.log gets only its length
$S/wd.ts text "[data-testid=render-status]"
$S/wd.ts gone "[data-testid=onboarding-wizard]"
$S/wd.ts eval "return innerHeight"          # inspection only, never to cause the behavior under test
T=$($S/wd.ts eval-secret "return window.__TAURI_INTERNALS__.invoke('mcp_token')")   # prints a string bare; logs only its length
$S/wd.ts shot settings-open                 # evidence/NN-settings-open.png, then a contrast sweep
$S/wd.ts contrast                           # every displayed select, text input, textarea, button on screen; exit 1 on a new failure below 3.0
$S/wd.ts end
```

`contrast [sel]` compares the colors a control's text is painted in with the background WebKit actually painted, cropped from the page screenshot. It catches text that is unreadable on screen while the CSS looks right, such as a native select drawn white under white text. It measures the control's own color when it holds text directly or is a field, and the color of every shown descendant that holds text, and the worst one counts, so a tertiary span inside a button is caught. Descendants under `aria-hidden="true"`, such as emoji icons, are decorative and skipped. An empty field is measured by its placeholder, read from the screenshot pixels inside its content box. Known failures are listed in `scripts/contrast-baseline.txt` with their measured ratio. A listed control prints `(baseline)` and does not fail the sweep while it measures within 0.05 of that ratio or above it. A new failure, or a known one that gets worse, fails. A descendant that paints its own background, such as a tinted badge, is measured on that surface. Remove a line when its control is fixed. A single sweep cannot tell a stale line, because an active tab or sidebar label is bright only on its own view, so check a line by sweeping every view. `shot` runs the same sweep and prints `contrast: N controls below 3.0 outside the baseline` on stderr, but still exits 0. The summary also counts hidden controls, so a clean result with many hidden ones does not read as full coverage.

Stable handles, in order of preference:

- `data-testid` attributes, such as `onboarding-wizard`, `btn-get-started`, `design-tab`, and `render-status`.
- `aria-label` values, for example the sidebar buttons `Library`, `MakerWorld`, `Design`, `Signs`, `Print Monitor`, `Print Queue`, and `History`, plus the toolbar buttons `Settings` and `printer connection status`.
- Role and label XPath for controls without testids, such as the Settings selects.

The feature files list the exact handles.

`actions.log` records the text of every `type` and the result of every `eval`. Never pass a key, access code, or token to `type` or read one with `eval`. Use `type-secret <sel> <ENV>` and `eval-secret <js>`, which log only the length **(observed 2026-11-03: a dummy key, an access code, and the MCP token each appeared 0 times in `actions.log`)**. Dummy strings such as `sk-test-dummy-0000` may go through `type`.

Quote an `aria-label` value that contains a space: `button[aria-label="Print Queue"]`. Unquoted, the selector fails with "invalid selector".

Some controls stay at opacity 0 until their row is hovered, for example the printer row's Delete button. WebDriver treats them as not displayed, so run `wd.ts hover <row>` first, then `click`.

Native GTK dialogs are outside the webview, so WebDriver cannot see them. Answer them the way a user does with `m3d.sh file-dialog <abs-path>`. The helper finds which dialog is open, "Open File" or "Save File", and types the path into it. "Open File" needs an existing file. "Save File" needs a new file name in an existing directory, because an existing target makes GTK ask to replace it in a second dialog the helper does not answer.

```bash
$S/wd.ts click "[data-testid=open-file-button]"
$S/m3d.sh file-dialog /absolute/path/to/model.scad
$S/wd.ts wait "[data-testid=design-toolbar]"     # the helper cannot see the outcome; the webview can
```

Settings and other SQLite side effects are read with bun's built-in SQLite, because the host has no `sqlite3` CLI:

```bash
bun -e 'import {Database} from "bun:sqlite"; const db = new Database(process.argv[1], {readonly: true}); console.log(JSON.stringify(db.query("select key, value from settings").all()))' \
  "$(readlink -f ~/m3d-verify/current)/xdg/data/com.aojdevstudio.materialize3d/materialize.db"
```

## Evidence

Everything lands in `~/m3d-verify/<run>/evidence/`:

- `NN-<name>.png` comes from `wd.ts shot`. It captures the webview only, at 1440x900 after `close-inspector`.
- `actions.log` holds one timestamped line per `wd.ts` command, including failures. It records the action alongside the state that resulted.
- `recording.mp4` comes from `m3d.sh record start` / `record stop` (ffmpeg x11grab of the run's display at 15 fps). Use it for flows. It shows the full screen, native dialogs included.

Test inputs you create go in `<run>/fixtures/` and are kept with the evidence.

A proof must meet these standards:

- Drive the user path: clicks, typing, and the native dialog. `wd.ts eval` and `invoke(...)` calls inspect state and never produce the behavior under test.
- Capture the action and the resulting state with a screenshot before and after, plus `actions.log`. The final screen alone is not enough.
- Verify the side effect as well as the pixels: the `settings` row, the file written, and the state after an app relaunch.
- Report an unreachable path together with the unmet precondition. For example, a Design render needs `openscad`, and chat needs a provider credential. Never swap in a different path and call the feature verified.
- For a PR, attach media per AGENTS.md. Pull the files first with `scp ossie@dev-substrate:m3d-verify/<run>/evidence/<file> .`, then attach them with `gh pr create|edit|comment --attach <file>`, or ship them with `pr-media <files>` if GitHub refuses them. Confirm each attachment renders on the PR page, and run `pr-media check` if the PR links any `pr-media` file.

## Cleanup

```bash
$S/m3d.sh down
```

`down` ends the WebDriver session, which closes the app. It stops ffmpeg, tauri-driver, Vite, and the Xvfb it started by killing each recorded process group. It never kills by process name. It deletes `xdg/` (app DB, WebKit storage), `pids/`, and `session`, then removes the `current` link. It keeps `evidence/`, `fixtures/`, `logs/`, and `env.json`. Copy anything you need from `xdg/` first, such as the app log in `xdg/data/com.aojdevstudio.materialize3d/logs/`. Run `down` after a failed `up` too, because `up` leaves partial state for inspection.

`up` runs `bun install --no-save` and pins `@tauri-apps/plugin-dialog` to the `Cargo.lock` version, also with `--no-save`. Since the Tauri 2.12 bump (PR 105), `bun.lock` already holds the matching 2.6.0, so the pin is only a guard. That leaves `package.json` and `bun.lock` untouched. Check `git status` before and after the run. Keep dependency and lockfile changes out of verification-only work.

## On macOS

This section describes a development driver from source. It is not installed-release acceptance. It was not driven for the 0.2.0 documentation update or for the 2026-11-03 update. Every step in this section runs only on macOS.

WebDriver cannot drive WKWebView, so `scripts/mac.ts` drives the app through the `e2e` harness in `src-tauri/src/e2e.rs`. That harness exists only in builds made with `--features e2e`. The release omits the endpoint and scripted dialog override. `mac.ts` targets the checkout's debug app bundle, not the copy installed from the release DMG. Its build command alone does not assemble the CAD helper and pinned runtime needed for parts. Run it on the Mac itself, the Mac mini (`ssh macmini-ts`).

```text
$S/mac.ts build                  # bun tauri build --debug --bundles app --features e2e
$S/mac.ts up                     # fresh data dir and its own token through M3D_E2E_*
$S/mac.ts wait <sel> [ms]
$S/mac.ts click <sel>
$S/mac.ts type <sel> <text>
$S/mac.ts text <sel>
$S/mac.ts count <sel>
$S/mac.ts shot <name>            # WebKit snapshot
$S/mac.ts eval <js>              # inspection only
$S/mac.ts restart                # relaunch on the same data
$S/mac.ts dialog <open-path> [save-path]
$S/mac.ts down
```

For installed-release automation, follow the [native verification tools](../../../docs/verify-on-mac.md#native-verification-tools) section. It records the signed CuaDriver route exercised on the mini and its window-targeting limits. Use the installed GUI checklist with real input and dialogs. Report missing permissions or tools as unmet prerequisites. A backend self-test, MCP call, or e2e debug run does not prove the installed GUI path.

## Feature map

`features/README.md` indexes one recipe per user-facing feature, including the landing site, which Playwright drives instead of `wd.ts`. A proof that drives one convenient entry point is incomplete when the map lists others. Update the map when a feature's handles or behavior change.
