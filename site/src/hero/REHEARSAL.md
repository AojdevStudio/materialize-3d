# Rehearsal: the product hero

Gold: `hero-demo` for the shape (named targets, five beats, a satellite that arrives with the payoff, a `compact` design). `ai-chat` for the request landing in a chat and the answer opening with its height. `loading` for rows that resolve in place. `fade-crop` for the window fading out at its foot. Kept from them: one window, measured `data-target`s for every press, `Collapse` for every row and line that arrives, `Roll` and `Count` for text and numbers that change, a payoff that holds, and a reset with a visible cause. Changed: the window is the Materialize 3D app (sidebar, chat, and right panel), drawn from the app's mockups, with the app's own outline icons and the dock mount render as the only raster image.

Beats: 1 type the request on the start screen (0 to 3 s). 2 Start, the chat opens, the dock mount appears under Working, trace lines land (3 to 6 s). 3 the last lines land and the guide fades into the right panel (6 to 9 s). 4 payoff and poster: Worked for 14 min, the answer heading, the dock mount moves to Ready to print with a green check, the print files card arrives (9 to 13 s, held 4 s). 5 New project is pressed and the start screen returns (13 to 14 s). Loop about 15 s.

Compact (below a 900px stage, so phones and tablets): one window with no sidebar. Beat 1 is the start screen with its chips. Beat 2 is the chat with a one-row composer at its foot. At beat 3 the guide panel slides in over the chat, the way the app's right panel opens. Beat 4, the poster, is the guide ("Dock mount assembly", the model render, "Step 6 of 13", "Screw the rails to the plate") with the print files card straddling the window's foot. The window runs off the right edge, and the page puts the stage on the screen's right edge, so the cut is the phone's own edge. The compact reset has no press, because the compact window has no New project button.

Captured: widths 1440 (wide, 1360 design at 1:1) and 390 (compact, 390 design at 1:1). Also checked as stills: 1024 (wide at 0.73), 768 (compact grown to 480, so 1.23, flush right of the centered copy), 430 (compact at 1.10) and 375 (compact at 0.96). Looks: light and dark page (the product stays light in both). Reduced motion: the poster, and a Playwright test at 1440 and 390 that it shows the model render inside the hero and holds still. States: `--states` at 1440.

Gate:
- 1440 loop: `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)`
- 390 loop: `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)`
- 1440 states: `rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)`

Film:
- `kit override` on the kit's own phone CSS (first 1440 still) → the kit sat at `src/stageshow/`, and film only knows kit CSS by a `/kit/` path → moved it to `src/stageshow/kit/`.
- `framing: whole but off center` (1440) → the window ended exactly at the stage edge → it now runs past the bottom, and the cut falls in the empty band above the composer.
- `lopsided` New project, `tight stack` on three title and subtitle pairs, `uneven padding` on the sidebar and main area, `tight inset` on the guide header → fixed at the source (hug the label, 3px between lines, even insets, the title in its own span).
- The print files card covered the Cable clip row → moved below the sidebar's last row.
- `framing: whole but off center`, `uneven gutters`, then `narrower than tall` (390) → the compact design was redone twice in the first round. It ended on a chat window whose trace folded to one header line, with no part in view: the wireframe failure.
- Second round, the compact payoff redone to show the part. Three compositions filmed as poster stills at 390: a whole window with the guide stacked, a whole window with the render beside the step, and a window bled off the right. Both whole windows fail framing. A whole window needs equal top and bottom margins, so a card below its foot forces a 68px top margin, and then the film asks for about 51px at the sides. Inside 326 x 260 the render is also under 120px tall. The right bleed passes and shows the render at 150px.
- The bled window was cut 16px short of the screen, which read as a clip → the page puts the compact stage on the screen's right edge below 932px.
- `tight control` on the card's Open in Bambu Studio, 5px under the window's foot → the foot now crosses the card in the gap above its buttons.
- `uneven gutters` on the card, measured against the page band → the card's center now sits inside the window, so the film reads it as on the window.
- `tight inset` and `uneven` on the card title → the two small buttons are wider than a 294px card. The card is 342px wide.
- `uneven padding` on the guide → the compact guide header pads 12px on top.
- A filler bar showed 1px above the card → the step text starts under the card's top edge.
- `empty pane`: 232px under the request bubble at beat 2 → the compact chat shows a one-row composer.
- `empty pane` over the whole window body in the start to chat handoff (slowed film) → in compact the two screens overlap their fades. Their words sit in different rows, so no text overlaps.
- The cursor rested on the Something from a photo chip → its rest point is under the chips.
- The panel slid in with no edge, so the chat looked sliced → the panel has a hairline on its leading edge.
- `tight inset` on the compact card (first round) → its buttons overflowed. The compact card uses small buttons, and it is keyed by layout because the kit measures a button's label once, at mount.
- `covers` on Start → the press aims off the label.
- Button labels clipped on first load → the kit measured them before Inter loaded. The stage mounts again once `document.fonts.ready` resolves.
- `near aligned` chips under the prompt (1440) → the prompt is wider, so the centered chips sit clearly inside it.
- Left as candidates, not gate lines. In the hero: `near-empty frames` at 390 for 0.5 to 0.9 s after Start, when the chat holds the request, the model label and the composer before the first trace line. That is the beat where the agent picks up the job. Also a `settle snap` under 2 px on `m3h-thread` at the end of the chat's fade-in, at both widths. In kit parts: `settle snap` on `ss-roll__mid` (11.5 and 55.9 px) and under 2 px on the two header rolls, and `appears with no entrance` on a `Count` reel. The small snaps change size from run to run. The large Roll shifts fit the reset, when the trace header has already collapsed and its text changes out of sight. I did not prove that timing frame by frame, because the film's 60 ms sampling ran at about 1 s on this machine.

Review: no fresh-eye reviewer ran. This was built by a leaf agent that starts no subagents. The parent's review stands in for it.

Bundle: the hero imports each kit part from its own module. The kit's `index.ts` also exports the brand-logo registry, which inlined 42 brand SVGs into the bundle and loaded every kit part's CSS. `bun run build` went from 401.71 kB JS (115.94 kB gzip) and 95.62 kB CSS to 309.94 kB JS (97.68 kB gzip) and 53.57 kB CSS. react-dom is 207 kB of what is left.

Assumptions:
- "Copy kit/ into site/src/stageshow/" is read as `site/src/stageshow/kit/` with the MIT `LICENSE` beside it.
- The model label shows no Claude mark. The kit's `BrandMark` registry has none.
- The working arc and the spinner hold still. Ossie's rule bans continuously repainting spinners, so the header's arc turns 60 degrees per landed step instead.

Deviations from the picked stills, each for a stageshow rule:
- The answer under "Your dock mount is ready" and the guide's step text are filler bars, not the still's real paragraphs and print files table. Real words stay where the story is (craft, Restraint).
- At 1440 the composer and the in-window print files bar sit below the crop. A window that ends at the stage edge reads as whole and off center (framing, rule 5), and an action sliced by the edge fails `cut by the crop`. The print files card carries the payoff in shot.
- The print files card straddles a third outside the window, as the brief asks. Framing rule 7 says about half.
- The 390 design is not the still's whole window with the card hanging off its foot. A whole window with a card below it fails the window-shape and gutter checks (framing, rules 10 to 12), and it leaves the render too small. The window runs off the right instead, and the card straddles its foot. The compact card drops the two file rows to fit, and the payoff shows the guide, not the finished trace.
- At 768 the compact window sits right of the centered copy, because it runs off the screen's right edge.
- On reset, the sidebar returns to three projects. The New project press is the visible cause (motion, Loops), but the dock mount row and the counts do rewind in view.

Unresolved:
- The `Count` reel and `Roll` candidates above are kit behavior. Fixing them means changing the vendored kit, which this change does not do.

Not checked:
- Real Safari, a Mac, or a real phone. Everything ran in headless Chromium on Linux.
- Touch, a hidden tab, and a return from offscreen during playback. The kit owns those paths.
- Live frame pacing on a high refresh display.
- The film's frame-by-frame pass of each press and handoff at 40 to 80 ms. This machine sampled at about 1 s, so each beat was judged from the 600 ms sheets and the states sheet.
