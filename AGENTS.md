# AGENTS.md — Materialize 3D

Project conventions for all AI agents working in this repo. Keep shared guidance in this file.
Keep `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md` absent from this repo, including ignored copies. Ignored root instruction files can still be copied into the tracked checker rubric.

## Project context

Materialize 3D provides agent-driven 3D modeling and Bambu Lab printer control.

- Sign packages are Bambu project 3MFs. `src-tauri/src/fabrication/bambu` slices them with only the validated Bambu Studio 02.08.02.61 build, resolves P2S presets, and verifies the G-code.
- The older STL path in `packages/bambu-slicer` and `src-tauri/src/slicer.rs` uses OrcaSlicer. It patches Bambu Studio G-code templates for OrcaSlicer at slice time.
- Development needs network access to the configured printer. Keep private device identifiers, addresses, and credentials outside tracked files.
- P2S Developer Mode enables local MQTT control and disables Bambu Handy access.

Run the headless slicer tests from `packages/bambu-slicer` with `bun test`.

## App verification

For app verification, screenshots, recordings, or UI proof, use [.agents/skills/verify-materialize-3d/SKILL.md](.agents/skills/verify-materialize-3d/SKILL.md). Follow its Linux launch and feature recipes.

## PR proof policy (required)

Every PR that changes user-visible behavior **must** include watchable proof in the PR body: a video for flows, a screenshot at minimum for static changes.

**Rules:**

1. **The reviewer must see the proof without checking anything out.** Never embed relative repo paths or `raw.githubusercontent.com` links; neither plays inline.
2. **Attach media with gh.** `gh pr create|edit|comment --attach <file>` (gh 2.99 or newer) uploads the file to GitHub and renders it inline in the PR. For files GitHub will not take, use `pr-media <files>`, which ships them as links; nothing on pr-media's host renders inline. `pr-media check` gates the PR against broken embeds.

   ```bash
   gh pr create --fill --attach './after.png#The new export dialog' --attach ./flow.mp4
   gh pr comment <N> --attach ./fix.gif
   ```

3. **Verify before relying on it:** open the PR page and confirm each attachment renders, or `curl -sL -o /dev/null -w "%{http_code}" <attachment-url>` returns `200`. gh exits non-zero when some attachments fail even though it created or updated the PR, so check each attachment and retry a failed one with `gh pr edit <N> --attach <file>` instead of re-running `gh pr create`. If the PR links any `pr-media` file, `pr-media check` must pass.
4. Files attached with `--attach` render inline: images and GIFs as images (GIFs autoplay), MP4s as a player. Files shipped through `pr-media` are plain links. Keep videos short (≤3 min, timelapse dead time), small (<5 MB), and 1600×900 or less.

## Recording on the Linux host

Follow the shared verification skill for `m3d.sh record start`, `m3d.sh record stop`, `wd.ts shot`, and `m3d.sh close-inspector`. Its launch creates isolated app data for each run.

## Pitfalls learned (don't re-step on these)

- `pkill -f "<pattern>"` in a shell command that itself contains `<pattern>` kills your own shell. Use bracket-globs (`[t]auri`) and never put the pattern twice in one command line.

<!-- pr-kit:start -->
## Pull requests

- Open every PR with the `open-pr` skill and land it with the `land-pr` skill. Both live in `.claude/skills/`.
- The PR body has five fixed sections: Problem, Change, Proof, Review, Merge danger. Merge danger names the door and the blast radius.
- The open-pr gate and the `pr-kit` CI check refuse a body that breaks the contract. Fix the body. Never route around either.
<!-- pr-kit:end -->
