# Navigation

The main UI has a left sidebar, a workspace tab bar, a context panel, a toolbar with printer status and Settings, a status bar, and the AI assistant panel on the right. Choosing a sidebar item or tab switches the workspace view.

## Sub-features

- `nav-sidebar` covers the `Library`, `MakerWorld`, `Design`, `Print Monitor`, `Print Queue`, and `History` buttons.
- `nav-tabs` covers the workspace tabs `Model Library`, `3D Preview`, `MakerWorld`, `OpenSCAD`, `Print Monitor`, and `Print History`.
- `nav-library` covers the Model Library view, its empty state, and search.
- `nav-history` covers the Print History view and its empty state.
- `nav-statusbar` covers the version, temperatures, and the online indicator.

## How to get to it (user POV)

- Click a sidebar icon. Each button has an `aria-label` equal to its label.
- Click a tab in the `Main workspace tabs` tab list.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.

- **Initial state (observed 2026-09-25).** Run `$S/wd.ts attr "nav[aria-label=Primary] button[aria-current=page]" ariaLabel`. It prints `Library`. The selected tab is `3D Preview`: `$S/wd.ts text "[role=tab][aria-selected=true]"`.
- **Design via sidebar (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label=Design]"` and `$S/wd.ts wait "[data-testid=design-tab]"`. `[data-testid=design-tab-empty]` reads "No file open".
- **Tab bar.** Run `$S/wd.ts click "text=Model Library"` and `$S/wd.ts wait "[data-testid=model-library]"`. On a fresh run, `[data-testid=model-library-empty]` reads "No models in library".
- **Library search.** Run `$S/wd.ts type "[data-testid=library-search-input]" "zzz"`. With models present, `[data-testid=model-library-no-results]` appears.
- **History (observed 2026-09-25, broken).** Run `$S/wd.ts click "button[aria-label=History]"`. The entire UI unmounts: `$S/wd.ts eval "return document.getElementById('root').innerHTML.length"` prints `0`. Relaunch the session to recover. A fix is proven when `[data-testid=print-history]` appears and `nav[aria-label=Primary]` is still present.

## Gotchas

- History crashes on `86ea7c8` because the context panel has no `history` entry, and that panel sits outside the error boundary. The `Print History` tab leads to the same view. Drive History last in a session, or relaunch afterwards.
- `Print Queue` has no view of its own. It falls through to the 3D Preview tab.
- The context panel's "Local models and recent imports" list is static placeholder content. Do not treat it as library data.
- Library rows come only from a startup scan of `<data>/library/makerworld/<slug>/metadata.json`. A new download appears after a relaunch.
- Print History rows need a real print to finish. The view does not load stored rows at mount.
