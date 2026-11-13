# Studio

The studio is the whole app. Each chat is a project folder in `~/Documents/Materialize 3D/<date>-<slug>/` (an `e2e` build uses `<M3D_E2E_DATA_DIR>/projects/`), and a conversation in the sidecar's store, `<app data>/state/store.sqlite` (an `e2e` build: `<M3D_E2E_DATA_DIR>/state/`). The sidecar, `Contents/MacOS/materialize-sidecar`, runs the agent through Pi Durable on the person's own inference login, with the app's own tools: `read`, `write`, and `edit` inside the project folder, `run` (uv), `slice` (the validated Bambu Studio, through Rust), and `astra` (GPT 6 Astra as a child task). The right panel has four views: Guide, Model, Drawing, and Files. HTML shows in a sandboxed frame, and STL, 3MF, and GLB in an orbit viewer. The newest guide, drawing, or model opens on its own. The Files tab lists every file, with Reveal in Finder and, for a 3MF, Open in Bambu Studio. The print files bar under the views opens the 3MF files in Bambu Studio.

## Sub-features

- `start-screen` holds "What are we making?", the `prompt` box, `attach`, `model-picker`, `send` (labeled Start), four suggestion chips that fill the box, and `recent` with the newest projects (`recent-<id>`).
- `prompt` takes text, pasted pictures, and links. The text is saved as the project's draft a moment after typing stops, and comes back when the project opens. A file dropped on the window or chosen with `attach` (labeled Attach) shows in `attachments` and is copied to the project's `refs/` on send. A picture reaches the model as an image block. Any other file, such as a PDF, 3MF, or STL, reaches it as its path in the message.
- `model-picker` lists the app's short list (`sidecar/src/offered.ts`) for each signed-in provider, by short name, such as Opus 5.5. A model the provider's catalog lacks stays out. The button names the chosen model even before any sign-in. A saved model the list does not name shows its id. On the start screen a pick is the default the next project starts with. In a project it is saved for that project.
- `messages` shows committed chat lines only: agent text as Markdown (`.msg-agent`), each turn's tool steps in one `trace` (a `.trace-step` line per step, `.step-running` until its result is committed, and a `.trace-head` button that folds the lines to one summary line), and `file-cards` after a turn that wrote previewable files or a 3MF. `working` shows while a turn runs (the running trace's head once the turn has a step), and `stop` replaces `send`.
- `byline` heads each turn's reply with the mark and short name of the model it ran on, such as Opus 5.5. A model the short list does not name shows its id. A reply imported from before the store has none. The chat has no title bar.
- `readiness` shows on the start screen while the agent lacks something, with the fix for each need: a sign-in, uv, a Python uv can run, or a model from a provider the app offers (the fix names the offered providers). A missing sign-in shows the same sign-in controls as `waiting`. `Check again` reruns the check. `send` stays disabled until nothing is missing.
- `waiting` shows when a turn stopped before its answer: the fix, and the control for it. A provider with no login shows `Sign in with Claude` or `Sign in with ChatGPT`, and for Anthropic and OpenCode Go a key form (`API key or token`, and for Anthropic `Proxy URL`). Once the login is saved, the turn goes on by itself. Any other failure shows its error and `Try again`.
- A turn cut off by quitting or a crash goes on from its last committed step when the app opens again.
- `engine` in the sidebar shows the sidecar's version, or why it stopped.
- `guide-tab`, `model-tab`, `drawing-tab`, and `files-tab` switch the right panel's view. Guide shows the newest `guide*.html` at the top of the project folder, Drawing the newest `drawing*.html`, and Model the newest STL, GLB, or glTF, or the newest 3MF when there is none. Files in `refs/` never count. A view with nothing to show has its tab disabled. A project opens on Guide when it has a guide, or else on the first view with something to show.
- `files-tab` opens `files-list`, with "Print files" (3MF) above "All files". A file that belongs to no view opens inside Files, with `All files` to go back to the list.
- `pop-out` opens the shown file in a new window, whose page is `pop-out-window`. The file list has no `pop-out`.
- `print-files` counts the 3MF files outside `refs/`. `Reveal in Finder` (`Show in folder` on Linux) and `open-in-bambu` act on the newest. With two or more, `print-pick` opens a menu of them all.
- `html-preview` is the iframe. `model-view` holds the orbit canvas.

## How to get to it (user POV)

- Open the app. The start screen shows. Type a request, optionally attach a file, and press Enter or Start.
- Earlier projects are in the left sidebar (`nav[aria-label=Projects]`). `new-project` returns to the start screen.

## Driving it with wd.ts

On macOS, drive it with `mac.ts` from an `e2e` build. Answer `Attach` with `mac.ts dialog <png>` before the click. A fresh data folder has no login, so `readiness` asks for one before `send` turns on. That order is from the code (`notReady` in `src/studio/StudioApp.tsx`). `ANTHROPIC_TOKEN` and `ANTHROPIC_PROXY` are the host's proxy token and URL.

```bash
bun $S/mac.ts wait '[data-testid=start-screen]' 30000
bun $S/mac.ts wait '[data-testid=readiness]' 20000
bun $S/mac.ts type '[aria-label="API key or token"]' "$ANTHROPIC_TOKEN"
bun $S/mac.ts type '[aria-label="Proxy URL"]' "$ANTHROPIC_PROXY"
bun $S/mac.ts click 'text=Save'
# If readiness still names uv or Python, install it, click 'text=Check again', and wait for the banner to clear.
bun $S/mac.ts dialog "$HOME/fixtures/sketch.png"
bun $S/mac.ts click 'text=Attach'
bun $S/mac.ts type '[data-testid=prompt]' 'Make a cable clip like in this sketch, then slice it to a 3MF'
bun $S/mac.ts wait '[data-testid=send]:not([disabled])' 20000
bun $S/mac.ts click '[data-testid=send]'
bun $S/mac.ts wait '[data-testid=working]' 20000
# A full job takes minutes. The file cards appear when the turn's last step is committed. One mac.ts wait is one
# HTTP request, which Bun ends after about five minutes, so a long wait goes in rounds.
for _ in 1 2 3 4; do bun $S/mac.ts wait '[data-testid=file-cards]' 240000 && break; done
bun $S/mac.ts click '[data-testid=files-tab]'
bun $S/mac.ts click '[data-testid=files-list] button.primary'   # Open in Bambu Studio
```

## Gotchas

- The sidecar's stderr is in the app log, as `sidecar: <line>`. Its first line lists the agent's tools.
- The sidecar reads none of the host's agent setup or environment. A login made with `claude` or `codex` on the host does not reach it.
- `mac.ts` selectors are CSS or `text=`. It has no XPath.
- A `mac.ts wait` longer than about five minutes fails with "The operation timed out", because Bun's fetch ends the one request it makes **(observed 2026-11-07)**. Wait in rounds of four minutes.
- The WebKit snapshot from `mac.ts shot` includes the iframe and the WebGL canvas **(observed 2026-11-06)**.
- Bambu Studio's own window is outside the webview. Check its process with `pgrep -x BambuStudio` after Open in Bambu Studio.
