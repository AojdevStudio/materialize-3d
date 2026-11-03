# Navigation

The main UI has a left sidebar, a workspace tab bar, a context panel, a toolbar with printer status and Settings, a status bar, and the AI assistant panel on the right. Choosing a sidebar item or tab switches the workspace view.

## Sub-features

- `nav-sidebar` covers the `Library`, `MakerWorld`, `Design`, `Signs`, `Print Monitor`, `Print Queue`, and `History` buttons.
- `nav-tabs` covers the workspace tabs `Model Library`, `3D Preview`, `Signs`, `MakerWorld`, `OpenSCAD`, `Print Monitor`, and `Print History`.
- `nav-library` covers the Model Library view, its empty state, search, and each card's `library-reslice` (selects the model and opens 3D Preview) and `library-delete` (removes the row and the model folder).
- `nav-history` covers the Print History view, its empty state, saved `history-card` rows with a `history-status` badge, and `history-delete`. Saved rows load at launch. A load failure reads "Could not load print history." with the reason.
- `nav-statusbar` covers the version (`v0.2.2`), temperatures, print progress, and the online indicator `.status-online`, which has no testid and reads `Offline · <printer>`, `Reconnecting · <printer>`, or `Online · <printer>`.
- `nav-db-guard` covers the launch refusal for a database that a newer app wrote (PR 87). See Gotchas.

## How to get to it (user POV)

- Click a sidebar icon. Each button has an `aria-label` equal to its label.
- Click a tab in the `Main workspace tabs` tab list.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.

- **Fresh run (observed 2026-11-03).** Model Library shows `model-library-empty` ("No models in library"), and `$S/wd.ts count "[data-testid=library-search-input]"` prints `0`, because an empty library has no search box. History shows "No prints recorded yet". The status bar reads `v0.2.2`, `🌡 N — °C · B — °C`, and `Offline · No Printer`.
- **Initial state (observed 2026-10-05, again 2026-11-03).** Run `$S/wd.ts attr "nav[aria-label=Primary] button[aria-current=page]" ariaLabel`. It prints `Library`. The selected tab is `3D Preview`: `$S/wd.ts text "[role=tab][aria-selected=true]"`.
- **Design via sidebar (observed 2026-10-05).** Run `$S/wd.ts click "button[aria-label=Design]"` and `$S/wd.ts wait "[data-testid=design-tab]"`. `[data-testid=design-tab-empty]` reads "No file open", and the selected tab is `OpenSCAD`.
- **Signs tab (observed 2026-10-05).** Run `$S/wd.ts click "text=Signs"` and `$S/wd.ts wait "[data-testid=signs-view]"`. The tab renders the Signs view, see [signs](./signs.md).
- **Tab bar (observed 2026-10-05).** Run `$S/wd.ts click "text=Model Library"` and `$S/wd.ts wait "[data-testid=model-library]"`. A fresh run shows `[data-testid=model-library-empty]` with "No models in library" **(observed 2026-11-03)**.
- **Library with models.** Needs at least one model, which today only a signed-in MakerWorld download provides, see [makerworld](./makerworld.md). Not driven. From source: `library-search-input` matches names only, after a 300 ms pause, and whitespace shows the full list again. `$S/wd.ts type "[data-testid=library-search-input]" "zzz" --clear` shows `model-library-no-results`. `library-reslice` switches the selected tab to `3D Preview`. `library-delete` removes the card.
- **History (observed 2026-10-05).** Run `$S/wd.ts click "button[aria-label=History]"` and `$S/wd.ts wait "[data-testid=print-history-empty]"`. It reads "No prints recorded yet", and `nav[aria-label=Primary]` is still mounted.
- **Saved history.** Needs a finished or failed print on a real printer. Not driven. From source, `history-card` rows show at launch without a printer connection, and `history-status` reads `Success` or `Failed`.
- **Print Queue (observed 2026-10-05).** Run `$S/wd.ts click 'button[aria-label="Print Queue"]'`. The selected tab is `3D Preview`.
- **Status bar (observed 2026-10-05).** Run `$S/wd.ts text ".status-online"`. On a fresh run it reads `Offline · No Printer`.

## Gotchas

- The `Print History` tab leads to the same view as the History sidebar button.
- `Print Queue` has no tab of its own. It falls through to the 3D Preview tab.
- Quote the `Print Queue` label in CSS: `button[aria-label="Print Queue"]`. Unquoted, the selector fails with "invalid selector".
- The context panel's "Local models and recent imports" list is static placeholder content. Do not treat it as library data.
- MakerWorld downloads and how they reach the Library are in [makerworld](./makerworld.md).
- Print History rows come from a real print that finishes or fails. The app loads saved rows at launch (`usePrintHistoryEvents` in `src/stores/printHistory.ts`), so they show after a relaunch without a printer.
- The context panel's "Library search" field has no search handler. Search with `library-search-input` in the view.
- A database whose schema is newer than this app reads stops launch before any window opens. A native dialog titled "Materialize 3D needs a newer version" explains how to reinstall the newer app or restore a backup, and closing it exits with code 1 (`src-tauri/src/lib.rs`). WebDriver has no webview to see, so a check needs `xdotool` on the run's display or a screenshot from `m3d.sh record`. Not driven.
