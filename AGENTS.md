# AGENTS.md — Materialize 3D

Project conventions for AI agents working in this repo. Read alongside CLAUDE.md.

## PR proof policy (required)

Every PR that changes user-visible behavior **must** include watchable proof in the PR body: a video for flows, a screenshot at minimum for static changes.

**Rules:**

1. **The reviewer must see the proof without checking anything out.** Never embed relative repo paths or `raw.githubusercontent.com` links; both break for a private repo and neither plays inline.
2. **Attach media with gh.** `gh pr create|edit|comment --attach <file>` (gh 2.99 or newer) uploads the file to GitHub and renders it inline in the PR. For files GitHub will not take, use `pr-media <files>`, which ships them as links; nothing on that host renders inline. `pr-media check` gates the PR against broken embeds.

   ```bash
   gh pr create --attach './after.png#The new export dialog' --attach ./flow.mp4
   gh pr comment <N> --attach ./fix.gif
   ```

3. **Verify before relying on it:** open the PR page and confirm each attachment renders, or `curl -sL -o /dev/null -w "%{http_code}" <attachment-url>` returns `200`. If the PR links any `pr-media` file, `pr-media check` must pass.
4. GIFs embed inline with `![alt](url)` and autoplay; MP4s go in as plain links (click → plays in browser). Keep videos short (≤3 min, timelapse dead time), small (<5 MB), and 1600×900 or less.

## Recording on the Linux host

The app runs headless on the devdesk X server:

```bash
DISPLAY=:99 npm run tauri dev           # app on the virtual display
ffmpeg -f x11grab -video_size 1920x1080 -framerate 24 -i :99 out.mp4   # record
DISPLAY=:99 scrot shot.png              # still
```

Mouse input via libxdo (no xdotool CLI installed). To re-run onboarding, delete `~/.local/share/com.aojdevstudio.materialize3d/` before launch.

## Pitfalls learned (don't re-step on these)

- `pkill -f "<pattern>"` in a shell command that itself contains `<pattern>` kills your own shell. Use bracket-globs (`[t]auri`) and never put the pattern twice in one command line.
- WebKitGTK inspector opens automatically in debug builds; close it via its ✕ button before capturing (F12 does nothing).
- Blind X11 clicks break when error banners shift layouts mid-flow. Screenshot-verify between clicks, or seed state directly in SQLite (`settings` table in `~/.local/share/com.aojdevstudio.materialize3d/materialize.db`).
