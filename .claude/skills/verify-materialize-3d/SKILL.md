---
name: verify-materialize-3d
description: Launch and drive the real Materialize 3D Tauri desktop app (React UI + Rust backend) on Linux through WebDriver, and capture screenshots, video, and SQLite side effects as proof. Use when asked to verify, demo, screenshot, or record a Materialize 3D UI flow, or to prove a PR's user-visible change per the AGENTS.md proof policy.
---

# Verify Materialize 3D

This skill drives the actual desktop app: the debug Rust binary with the real backend, rendered by WebKitGTK on a private Xvfb display, controlled through `tauri-driver` → `WebKitWebDriver`. The browser IPC mock in `src/dev/tauriBrowserMock.ts` never installs here, because the real window has `__TAURI_INTERNALS__`.

## Where it runs

Run on the Linux host, dev-substrate (`ssh ossie@dev-substrate`, Ubuntu 24.04.5). It has Xvfb, `WebKitWebDriver`, `tauri-driver` (`~/.cargo/bin`), xdotool, ffmpeg, and `keyctl`. `m3d.sh up` refuses to start on a host that is missing any of them. An Arch/Hyprland desktop lacks Xvfb, WebKitWebDriver, and tauri-driver, and it has no passwordless sudo.

To verify work that lives on another machine, get the same tree onto the Linux host. Either push the branch and `git worktree add ~/m3d-<topic> <branch>`, or `rsync -a --exclude node_modules --exclude src-tauri/target <tree>/ ossie@dev-substrate:m3d-<topic>/`. Run every command below from that checkout's root.

Only one run per host. Vite's port 1420 is fixed by `vite.config.ts` (`strictPort`) and by `devUrl` in `tauri.conf.json`. `up` refuses when 1420, 4444, or 4445 is already bound. Never drive an instance you did not start.

## Launch

```bash
S=.claude/skills/verify-materialize-3d/scripts
$S/m3d.sh up                 # deps, cargo build, Xvfb, Vite, tauri-driver; prints run dir
$S/wd.ts session             # launches the app window; prints the session id
$S/wd.ts wait 'nav[aria-label=Primary], [data-testid=onboarding-wizard]' 30000
$S/m3d.sh close-inspector    # debug builds dock devtools over the bottom 300px
```

`up` is ready when it prints `m3d: ready run=... display=:9N rev=<sha>`. A first cargo build takes a few minutes; later builds are incremental. Each run gets `~/m3d-verify/<timestamp>/`, and `~/m3d-verify/current` points at the active run.

`up` isolates app state with `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` under the run dir. A fresh run therefore starts at onboarding with an empty DB at `<run>/xdg/data/com.aojdevstudio.materialize3d/materialize.db`. `wd.ts end` followed by `wd.ts session` relaunches the app on the same data, which is how you prove persistence.

`up` launches tauri-driver, and so the app, under `keyctl session -`. The app keeps API keys and the MCP token in the Linux kernel keyring, and an SSH command's session keyring is revoked when the command ends. Without its own session keyring, every credential read fails with "No matching entry found in secure storage", the Agent section of Settings shows only that error, and enabling MCP fails.

Set `M3D_DISPLAY=:99` before `up` to reuse the long-lived devdesk Xvfb. `up` then starts no display of its own and `down` leaves `:99` running.

Why not `bun tauri dev` or `bun tauri build`? `tauri dev` attaches the app to the terminal and cannot be handed to WebDriver. `bun run build` (`tsc && vite build`) currently fails typecheck on `main`. The skill runs the same pieces that `tauri dev` runs: Vite on :1420 plus the debug binary that `cargo build` produces, which loads `devUrl`.

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
$S/wd.ts text "[data-testid=render-status]"
$S/wd.ts gone "[data-testid=onboarding-wizard]"
$S/wd.ts eval "return innerHeight"          # inspection only, never to cause the behavior under test
$S/wd.ts shot settings-open                 # evidence/NN-settings-open.png, then a contrast sweep
$S/wd.ts contrast                           # every displayed select, text input, textarea, button on screen; exit 1 below 3.0
$S/wd.ts end
```

`contrast [sel]` compares each control's CSS text color with the background WebKit actually painted, cropped from the page screenshot, so it catches text that is unreadable on screen while the CSS looks right, such as a native select drawn white under white text. `shot` runs the same sweep and prints `contrast: N controls below 3.0` on stderr, but still exits 0.

Stable handles, in order of preference:

- `data-testid` attributes, such as `onboarding-wizard`, `btn-get-started`, `design-tab`, and `render-status`.
- `aria-label` values, for example the sidebar buttons `Library`, `MakerWorld`, `Design`, `Signs`, `Print Monitor`, `Print Queue`, and `History`, plus the toolbar buttons `Settings` and `printer connection status`.
- Role and label XPath for controls without testids, such as the Settings selects.

The feature files list the exact handles.

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

`down` ends the WebDriver session, which closes the app. It stops ffmpeg, tauri-driver, Vite, and the Xvfb it started by killing each recorded process group. It never kills by process name. It deletes `xdg/` (app DB, WebKit storage), `pids/`, and `session`, then removes the `current` link. It keeps `evidence/`, `fixtures/`, `logs/`, and `env.json`. Run `down` after a failed `up` too, because `up` leaves partial state for inspection.

`up` runs `bun install --no-save` and pins `@tauri-apps/plugin-dialog` to the `Cargo.lock` version, also with `--no-save`. That leaves `package.json` and `bun.lock` untouched. `bun.lock` on `main` is missing `@tauri-apps/plugin-dialog`, `@monaco-editor/react`, and `monaco-editor`, so a plain `bun install` rewrites it; check `git status` before committing anything.

## On macOS

This section is described from source. `scripts/mac.ts` was not driven in the 2026-10-05 pass.

WebDriver cannot drive WKWebView, so `scripts/mac.ts` drives the app through the `e2e` harness in `src-tauri/src/e2e.rs`. That harness exists only in builds made with `--features e2e`. Run it on the Mac itself, the Mac mini (`ssh macmini-ts`).

```bash
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

## Feature map

`features/README.md` indexes one recipe per user-facing feature. A proof that drives one convenient entry point is incomplete when the map lists others. Update the map when a feature's handles or behavior change.
