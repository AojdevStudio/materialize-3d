# Navigation

The main UI has a left sidebar, a workspace tab bar, a context panel, a toolbar with printer status and Settings, a status bar, and the AI assistant panel on the right. Choosing a sidebar item or tab switches the workspace view.

## Sub-features

- `nav-sidebar` covers the `Library`, `MakerWorld`, `Design`, `Signs`, `Print Monitor`, `Print Queue`, and `History` buttons.
- `nav-tabs` covers the workspace tabs `Model Library`, `3D Preview`, `Signs`, `MakerWorld`, `OpenSCAD`, `Print Monitor`, and `Print History`.
- `nav-library` covers the Model Library view, its empty state, and search.
- `nav-history` covers the Print History view and its empty state.
- `nav-statusbar` covers the version, temperatures, and the online indicator `.status-online`, which reads `Offline · <printer>` and has no testid.

## How to get to it (user POV)

- Click a sidebar icon. Each button has an `aria-label` equal to its label.
- Click a tab in the `Main workspace tabs` tab list.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.

- **Initial state (observed 2026-10-05).** Run `$S/wd.ts attr "nav[aria-label=Primary] button[aria-current=page]" ariaLabel`. It prints `Library`. The selected tab is `3D Preview`: `$S/wd.ts text "[role=tab][aria-selected=true]"`.
- **Design via sidebar (observed 2026-10-05).** Run `$S/wd.ts click "button[aria-label=Design]"` and `$S/wd.ts wait "[data-testid=design-tab]"`. `[data-testid=design-tab-empty]` reads "No file open", and the selected tab is `OpenSCAD`.
- **Signs tab (observed 2026-10-05).** Run `$S/wd.ts click "text=Signs"` and `$S/wd.ts wait "[data-testid=signs-view]"`. The tab renders the Signs view, see [signs](./signs.md).
- **Tab bar (observed 2026-10-05).** Run `$S/wd.ts click "text=Model Library"` and `$S/wd.ts wait "[data-testid=model-library]"`. Per the source, a fresh run shows `[data-testid=model-library-empty]` with "No models in library". That text was not checked live.
- **Library search.** Run `$S/wd.ts type "[data-testid=library-search-input]" "zzz"`. With models present, `[data-testid=model-library-no-results]` appears.
- **History (observed 2026-10-05).** Run `$S/wd.ts click "button[aria-label=History]"` and `$S/wd.ts wait "[data-testid=print-history-empty]"`. It reads "No prints recorded yet", and `nav[aria-label=Primary]` is still mounted.
- **Print Queue (observed 2026-10-05).** Run `$S/wd.ts click 'button[aria-label="Print Queue"]'`. The selected tab is `3D Preview`.
- **Status bar (observed 2026-10-05).** Run `$S/wd.ts text ".status-online"`. On a fresh run it reads `Offline · No Printer`.

## Gotchas

- The `Print History` tab leads to the same view as the History sidebar button.
- `Print Queue` has no tab of its own. It falls through to the 3D Preview tab.
- Quote the `Print Queue` label in CSS: `button[aria-label="Print Queue"]`. Unquoted, the selector fails with "invalid selector".
- The context panel's "Local models and recent imports" list is static placeholder content. Do not treat it as library data.
- Library rows come only from a startup scan of `<data>/library/makerworld/<slug>/metadata.json`. A new download appears after a relaunch.
- Print History rows need a real print to finish. The view does not load stored rows at mount.
