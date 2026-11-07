# Studio

The studio is the whole app. Each chat is a project folder in `~/Documents/Materialize 3D/<date>-<slug>/` (an `e2e` build uses `<M3D_E2E_DATA_DIR>/projects/`). A turn runs the local `claude` CLI with Opus 5.5 in that folder on the person's own login. The right panel shows whatever the agent writes: HTML in a sandboxed frame, STL, 3MF, and GLB in an orbit viewer, and pictures. The newest such file opens on its own. The Files tab lists every file, with Reveal in Finder and, for a 3MF, Open in Bambu Studio. The other recipes in this map describe screens the studio hides.

## Sub-features

- `start-screen` holds "What are we making?", the `prompt` box, `Add picture`, `send`, and three suggestion chips that fill the box.
- `prompt` takes text, pasted pictures, and links. A picture dropped on the window or chosen with `Add picture` shows in `attachments` and is copied to the project's `refs/` on send. It reaches the model as an image block.
- `messages` shows each tool step on one line (`.tool`, with `.tool-running` while it runs), agent text, `file-cards` after a turn that wrote previewable files or a 3MF, and `.msg-error` for a failed or stopped turn. `working` shows while a turn runs, and `stop` replaces `send`.
- `stop` ends the agent and every tool it started (its process group).
- The agent runs lean: the person's inference login only (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `API_TIMEOUT_MS`, and `apiKeyHelper` from `~/.claude/settings.json`), `--setting-sources project`, no MCP servers, no CLAUDE.md or auto-memory, and the app's own `materialize-studio` plugin from the bundle's `studio-plugin` resource. Astra runs with `CODEX_HOME` set to `<app data>/astra`, which holds only the cliproxy provider and turns off the skills under `~/.agents/skills`. A turn's `system` `init` line in the transcript lists its tools, MCP servers, plugins, and skills.
- A turn cut off by quitting the app ends when the project reopens, with "This turn stopped when the app closed."
- `files-tab` opens `files-list`, with "Print files" (3MF) above "All files".
- `html-preview` is the iframe. `model-view` holds the orbit canvas.

## How to get to it (user POV)

- Open the app. The start screen shows. Type a request, optionally add a picture, and press Enter or Send.
- Earlier projects are in the left sidebar (`nav[aria-label=Projects]`). `new-project` returns to the start screen.

## Driving it with wd.ts

On macOS, drive it with `mac.ts` from an `e2e` build. Answer `Add picture` with `mac.ts dialog <png>` before the click. `PROJECT` is the one folder under `<run>/data/projects/`.

```bash
bun $S/mac.ts wait '[data-testid=start-screen]' 30000
bun $S/mac.ts dialog "$HOME/fixtures/sketch.png"
bun $S/mac.ts click 'text=Add picture'
bun $S/mac.ts type '[data-testid=prompt]' 'Make a cable clip like in this sketch, then slice it to a 3MF'
bun $S/mac.ts click '[data-testid=send]'
bun $S/mac.ts wait '[data-testid=working]' 20000
# A full job takes minutes. Wait for its end line in the transcript, then for the file card.
until grep -q m3d_turn_end "$PROJECT/.m3d/transcript.jsonl"; do sleep 10; done
bun $S/mac.ts wait '[data-testid=file-cards]' 30000
bun $S/mac.ts click '[data-testid=files-tab]'
bun $S/mac.ts click '[data-testid=files-list] button.primary'   # Open in Bambu Studio
```

The transcript is `<project>/.m3d/transcript.jsonl`. A finished turn ends with an `m3d_turn_end` line. Wait on that line, not on a clock.

## Gotchas

- A turn needs `claude` signed in on the host. Without it the turn ends at once with the CLI's error in `.msg-error`.
- Claude Code refuses a bare `sleep`. To test Stop, ask for `python3 -c 'import time; time.sleep(300)'` in the foreground **(observed 2026-11-06)**.
- `mac.ts` selectors are CSS or `text=`. It has no XPath.
- The WebKit snapshot from `mac.ts shot` includes the iframe and the WebGL canvas **(observed 2026-11-06)**.
- Bambu Studio's own window is outside the webview. Check its process with `pgrep -x BambuStudio` after Open in Bambu Studio.
