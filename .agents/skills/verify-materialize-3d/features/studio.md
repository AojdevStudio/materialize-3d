# Studio

The studio is the whole app. Each chat is a project folder in `~/Documents/Materialize 3D/<date>-<slug>/` (an `e2e` build uses `<M3D_E2E_DATA_DIR>/projects/`), and a conversation in the sidecar's store, `<app data>/state/store.sqlite` (an `e2e` build: `<M3D_E2E_DATA_DIR>/state/`). The sidecar, `Contents/MacOS/materialize-sidecar`, runs the agent through Pi Durable on the person's own inference login, with the app's own tools: `read`, `write`, and `edit` inside the project folder, `run` (uv), `slice` (the validated Bambu Studio, through Rust), and `astra` (GPT 6 Astra as a child task). The right panel shows whatever the agent writes: HTML in a sandboxed frame, STL, 3MF, and GLB in an orbit viewer, and pictures. The newest such file opens on its own. The Files tab lists every file, with Reveal in Finder and, for a 3MF, Open in Bambu Studio.

## Sub-features

- `start-screen` holds "What are we making?", the `prompt` box, `Add picture`, `send`, and three suggestion chips that fill the box.
- `prompt` takes text, pasted pictures, and links. The text is saved as the project's draft a moment after typing stops, and comes back when the project opens. A picture dropped on the window or chosen with `Add picture` shows in `attachments` and is copied to the project's `refs/` on send. It reaches the model as an image block.
- `messages` shows committed chat lines only: each tool step on one line (`.tool`, with `.tool-running` until its result is committed), agent text, and `file-cards` after a turn that wrote previewable files or a 3MF. `working` shows while a turn runs, and `stop` replaces `send`.
- `chat-model` names the model the current turn runs with.
- `readiness` shows on the start screen while the agent lacks a sign-in, uv, or a Python uv can run, with the fix for each. A missing sign-in shows the same sign-in controls as `waiting`. `send` stays off until nothing is missing.
- `waiting` shows when a turn stopped before its answer: the fix, and the control for it. A provider with no login shows `Sign in with Claude` or `Sign in with ChatGPT`, and for Anthropic and OpenCode Go a key form (`API key or token`, and for Anthropic `Proxy URL`). Once the login is saved, the turn goes on by itself. Any other failure shows its error and `Try again`.
- A turn cut off by quitting or a crash goes on from its last committed step when the app opens again.
- `engine` in the sidebar shows the sidecar's version, or why it stopped.
- `files-tab` opens `files-list`, with "Print files" (3MF) above "All files".
- `html-preview` is the iframe. `model-view` holds the orbit canvas.

## How to get to it (user POV)

- Open the app. The start screen shows. Type a request, optionally add a picture, and press Enter or Send.
- Earlier projects are in the left sidebar (`nav[aria-label=Projects]`). `new-project` returns to the start screen.

## Driving it with wd.ts

On macOS, drive it with `mac.ts` from an `e2e` build. Answer `Add picture` with `mac.ts dialog <png>` before the click. A fresh data folder has no login, so `readiness` asks for one before `send` turns on. That order is from the code (`notReady` in `src/studio/StudioApp.tsx`). `ANTHROPIC_TOKEN` and `ANTHROPIC_PROXY` are the host's proxy token and URL.

```bash
bun $S/mac.ts wait '[data-testid=start-screen]' 30000
bun $S/mac.ts wait '[data-testid=readiness]' 20000
bun $S/mac.ts type '[aria-label="API key or token"]' "$ANTHROPIC_TOKEN"
bun $S/mac.ts type '[aria-label="Proxy URL"]' "$ANTHROPIC_PROXY"
bun $S/mac.ts click 'text=Save'
bun $S/mac.ts dialog "$HOME/fixtures/sketch.png"
bun $S/mac.ts click 'text=Add picture'
bun $S/mac.ts type '[data-testid=prompt]' 'Make a cable clip like in this sketch, then slice it to a 3MF'
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
