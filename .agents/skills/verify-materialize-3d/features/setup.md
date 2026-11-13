# Setup

A fresh store opens setup instead of the studio. Welcome has `Start setup`. Check your Mac has a row for each sign-in (Claude and ChatGPT), Bambu Studio, uv, and Python. Each row shows Checking, Ready, Needs login, Needs uv, Missing (a required tool), or Not found (an optional one). Continue waits for one sign-in, uv, and Python. Without Bambu Studio it reads `Continue without a slicer`. Pick a model offers the signed-in agents' models, with a switch that lets the main agent ask Astra for drawings, and Back. Your printer shows the printer Bambu Studio last used, or a pick of every printer the validated Bambu Studio slices for. Without that Bambu Studio it passes straight to Ready. Ready sums up the agent, the slicer, the printer, and the build tools. `Start a project` saves setup as done, and the [studio](./studio.md) start screen opens. A store from v0.3.0 or earlier counts as set up, so it opens the studio.

## Sub-features

- `setup` is the whole screen. The card's `section` has the step's name as its `aria-label`: `Welcome`, `Check your Mac`, `Pick a model`, `Your printer`, or `Ready`. The `h1` says what the check found, such as `Your Mac is ready` or `No slicer found`.
- `check-claude`, `check-chatgpt`, `check-bambu`, `check-uv`, and `check-python` are the rows. `.setup-status` holds the status and `.setup-detail` the version or the reason.
- A sign-in row without a login has `Sign in`, the subscription sign-in. The Claude row also has `Use a key`, which opens the `API key or token` and `Proxy URL` form. Setup is the only place with that form.
- A missing uv or Python has `Copy install command`.
- `Check again` runs the whole check again.
- Pick a model has a radio for each model of a signed-in agent, grouped by agent (`fieldset` named `Claude` or `ChatGPT`). The saved default starts picked. The switch `Let the main agent ask GPT (Astra) for drawings` is off and disabled without a ChatGPT sign-in. Continue saves both as the default model and the Astra setting.
- Your printer reads Bambu Studio's `BambuStudio.conf`. When it names a Bambu Lab printer, quality, and filament, the `h1` is `Is this your printer?` and `printer-found` lists Printer, Nozzle, Filament, Plate, and Quality, with `Change` and `Looks right`. Otherwise the `h1` is `Pick your printer`, with a `select` for each of Printer, Nozzle, Filament, Plate, and Quality, and `Back` and `Save`. A printer change resets the parts that do not fit the new one to Bambu Studio's defaults. `Looks right` and `Save` save through `printer.set`. A refusal shows its reason in a `role=alert` line and stays on the step.
- Ready has `ready-agent`, `ready-slicer`, `ready-printer`, and `ready-tools`. Each reads `Checking…` until its part answers.
- `Fix in setup` on a [studio](./studio.md) `setup-needed` banner opens Check your Mac again, with `Back` above the card. Continue and `Back` both return to the screen it was opened from, and save nothing. A sign-in a waiting turn was refused with shows Needs login on its row.

## How to get to it (user POV)

- Open the app on a fresh store. Welcome shows. Press `Start setup`.

## Driving it with wd.ts

```bash
$S/wd.ts wait '[data-testid=setup]' 60000
$S/wd.ts click 'text=Start setup'
$S/wd.ts wait 'section[aria-label="Check your Mac"]'
$S/wd.ts click '[data-testid=check-claude] .setup-link'   # Use a key
$S/wd.ts type-secret '[aria-label="API key or token"]' KEY --clear
$S/wd.ts type-secret '[aria-label="Proxy URL"]' PROXY --clear
$S/wd.ts click 'text=Save'
$S/wd.ts wait '.setup-actions .primary:not([disabled])' 60000
$S/wd.ts click '.setup-actions .primary'
$S/wd.ts wait 'section[aria-label="Pick a model"] input[type=radio]:checked'
$S/wd.ts click 'text=Continue'
$S/wd.ts wait 'section[aria-label="Your printer"] .setup-actions .primary' 30000   # skip this and the next line without Bambu Studio
$S/wd.ts click 'section[aria-label="Your printer"] .setup-actions .primary'   # Looks right, or Save
$S/wd.ts wait 'section[aria-label="Ready"]'
$S/wd.ts click 'text=Start a project'
$S/wd.ts wait '[data-testid=start-screen]' 30000
```

Each state comes from the environment `up` runs in, since the app inherits it:

- Bambu Studio Ready: export `BAMBU_STUDIO_CLI` to the validated build. A path that does not exist gives Not found.
- Your printer found: after `up`, before the printer step, write a `BambuStudio.conf` to `<run>/xdg/config/BambuStudio/`. The app reads it each time the step opens. With no file there, the step opens on the pick. `src-tauri/tests/fixtures/bambu/config/BambuStudio.conf` is a real one cut down: P2S, 0.4 mm, PETG Basic, and `curr_bed_type` 4, the Textured PEI Plate. Set it to 5 for the SuperTack Plate.
- uv Missing: run `up` with a `HOME` and a `PATH` that hold no uv, because the sidecar also looks in `$HOME/.local/bin`. Keep `CARGO_HOME`, `RUSTUP_HOME`, `BUN_INSTALL_CACHE_DIR`, and `M3D_RUNS` on the real ones.

## Gotchas

- A recipe that waits for `start-screen` on a fresh store passes setup first, which needs a sign-in, uv, and Python.
- The Bambu Studio row stays Checking for the seconds Bambu Studio takes to answer `--help`.
