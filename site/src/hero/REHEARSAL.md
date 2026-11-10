# Rehearsal: the product hero

Gold: `hero-demo` for the shape (named targets, five beats, a satellite that arrives with the payoff, a `compact` design). `ai-chat` for the request landing in a chat and the answer opening with its height. `loading` for rows that resolve in place. `fade-crop` for the window fading out at its foot. Kept from them: one window, measured `data-target`s for every press, `Collapse` for every row and line that arrives, `Roll` and `Count` for text and numbers that change, a payoff that holds, and a reset with a visible cause. Changed: the window is the Materialize 3D app (sidebar, chat, and right panel), drawn from the app's mockups, with the app's own outline icons and the dock mount render as the only raster image.

Beats: 1 type the request on the start screen (0 to 3 s). 2 Start, the chat opens, the dock mount appears under Working, trace lines land (3 to 6 s). 3 the last lines land and the guide fades into the right panel (6 to 9 s). 4 payoff and poster: Worked for 14 min, the answer heading, the dock mount moves to Ready to print with a green check, the print files card arrives (9 to 13 s, held 4 s). 5 New project is pressed and the start screen returns (13 to 14 s). Loop about 15 s.

Captured: widths 1440 (wide, 1360 design at 1:1) and 390 (compact, 358 design at 1:1). Also checked as stills: 1024 (wide at 0.73) and 768 (compact grown to 480). Looks: light and dark page (the product stays light in both). Reduced motion: the poster, and a Playwright test that it holds still. States: `--states` at 1440.

Gate:
- 1440 loop: `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)`
- 390 loop: `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)`
- 1440 states: `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)`

Film:
- `kit override` on the kit's own phone CSS (first 1440 still) → the kit sat at `src/stageshow/`, and film only knows kit CSS by a `/kit/` path → moved it to `src/stageshow/kit/`.
- `framing: whole but off center` (1440) → the window ended exactly at the stage edge → it now runs past the bottom, and the cut falls in the empty band above the composer.
- `lopsided` New project, `tight stack` on three title and subtitle pairs, `uneven padding` on the sidebar and main area, `tight inset` on the guide header → fixed at the source (hug the label, 3px between lines, even insets, the title in its own span).
- The print files card covered the Cable clip row → moved below the sidebar's last row.
- `framing: whole but off center`, `uneven gutters`, then `narrower than tall` (390) → the compact design was redone twice. It now shows the chat column in a window that runs off the bottom and shows no taller than it is wide. At the payoff the finished trace folds to its header and the card lands in the room it leaves.
- `tight inset` on the compact card → its buttons overflowed. The compact card uses small buttons, and it is keyed by layout because the kit measures a button's label once, at mount.
- `covers` on Start → the press aims off the label.
- Button labels clipped on first load → the kit measured them before Inter loaded. The stage mounts again once `document.fonts.ready` resolves.
- `near aligned` chips under the prompt (1440) → the prompt is wider, so the centered chips sit clearly inside it.
- Left as candidates, not gate lines: `settle snap` on `ss-roll__mid` (11.5 and 55.9 px) and on the two header rolls (0.7 px), and `appears with no entrance` on a `Count` reel. All are inside kit parts. The large Roll shifts fit the reset, when the header has already folded away and its text changes out of sight. I did not prove that timing frame by frame, because the film's 60 ms sampling ran at about 1 s on this machine.

Review: no fresh-eye reviewer ran. This was built by a leaf agent that starts no subagents. The parent's review stands in for it.

Assumptions:
- "Copy kit/ into site/src/stageshow/" is read as `site/src/stageshow/kit/` with the MIT `LICENSE` beside it.
- The model label shows no Claude mark. The kit's `BrandMark` registry has none.
- The working arc and the spinner hold still. Ossie's rule bans continuously repainting spinners, so the header's arc turns 60 degrees per landed step instead.

Deviations from the picked stills, each for a stageshow rule:
- The answer under "Your dock mount is ready" and the guide's step text are filler bars, not the still's real paragraphs and print files table. Real words stay where the story is (craft, Restraint).
- At 1440 the composer and the in-window print files bar sit below the crop. A window that ends at the stage edge reads as whole and off center (framing, rule 5), and an action sliced by the edge fails `cut by the crop`. The print files card carries the payoff in shot.
- The print files card straddles a third outside the window, as the brief asks. Framing rule 7 says about half.
- The 390 design is not the still's whole window with the card hanging off its foot. That composition fails the window-shape rule (rule 12) and leaves a dead band under the window for the first 9 seconds. The compact card also drops the two file rows to fit.
- On reset, the sidebar returns to three projects. The New project press is the visible cause (motion, Loops), but the dock mount row and the counts do rewind in view.

Unresolved:
- The `Count` reel and `Roll` candidates above are kit behavior. Fixing them means changing the vendored kit, which this change does not do.

Not checked:
- Real Safari or a Mac. Everything ran in headless Chromium on Linux.
- Touch, a hidden tab, and a return from offscreen during playback. The kit owns those paths.
- Live frame pacing on a high refresh display.
- The film's frame-by-frame pass of each press and handoff at 40 to 80 ms. This machine sampled at about 1 s, so each beat was judged from the 600 ms sheets and the states sheet.
