# Setup

A fresh store opens setup instead of the studio. Welcome has `Start setup`. Check your Mac has a row for each sign-in (Claude and ChatGPT), Bambu Studio, uv, and Python. Each row shows Checking, Ready, Needs login, Needs uv, Missing (a required tool), or Not found (an optional one). Continue waits for one sign-in, uv, and Python. Without Bambu Studio it reads `Continue without a slicer`. Continue on the last step saves setup as done, and the [studio](./studio.md) start screen opens. A store from v0.3.0 or earlier counts as set up, so it opens the studio.

## Sub-features

- `setup` is the whole screen. The card's `section` has the step's name as its `aria-label`, `Welcome` or `Check your Mac`. The `h1` says what the check found, such as `Your Mac is ready` or `No slicer found`.
- `check-claude`, `check-chatgpt`, `check-bambu`, `check-uv`, and `check-python` are the rows. `.setup-status` holds the status and `.setup-detail` the version or the reason.
- A sign-in row without a login has `Sign in`, the subscription sign-in. The Claude row also has `Use a key`, which opens the same `API key or token` and `Proxy URL` form as `waiting`.
- A missing uv or Python has `Copy install command`.
- `Check again` runs the whole check again.

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
$S/wd.ts wait "xpath=//h1[normalize-space()='Your Mac is ready']" 60000
$S/wd.ts click 'text=Continue'
$S/wd.ts wait '[data-testid=start-screen]' 30000
```

Each state comes from the environment `up` runs in, since the app inherits it:

- Bambu Studio Ready: export `BAMBU_STUDIO_CLI` to the validated build. A path that does not exist gives Not found.
- uv Missing: run `up` with a `HOME` and a `PATH` that hold no uv, because the sidecar also looks in `$HOME/.local/bin`. Keep `CARGO_HOME`, `RUSTUP_HOME`, `BUN_INSTALL_CACHE_DIR`, and `M3D_RUNS` on the real ones.

## Gotchas

- A recipe that waits for `start-screen` on a fresh store passes setup first, which needs a sign-in, uv, and Python.
- The Bambu Studio row stays Checking for the seconds Bambu Studio takes to answer `--help`.
