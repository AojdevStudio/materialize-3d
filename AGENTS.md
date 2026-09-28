# AGENTS.md — Materialize 3D

Project conventions for AI agents working in this repo. Read alongside CLAUDE.md.

## PR proof policy (required)

Every PR that changes user-visible behavior **must** include watchable proof in the PR body: a video for flows, a screenshot at minimum for static changes.

**Rules:**

1. **Always use public URLs.** Embed media from the public R2 bucket, never relative repo paths and never `raw.githubusercontent.com` links — both break for a private repo and neither plays inline. The reviewer must be able to click and watch without checking out anything.
2. **Upload media to your R2 bucket** under `materialize-3d/pr-<N>/<filename>`:

   ```bash
   set -a; source ~/.env; set +a
   bunx wrangler r2 object put "<bucket>/materialize-3d/pr-<N>/<file>" --file <file> --remote
   # public URL:
   # https://<your-public-bucket-host>/materialize-3d/pr-<N>/<file>
   ```

   The `--remote` flag is **mandatory** — wrangler 4 defaults `r2 object` commands to a local simulation, which reports "Upload complete" but never reaches the real bucket.

3. **Verify before linking:** `curl -s -o /dev/null -w "%{http_code}" <public-url>` must return `200`.
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
