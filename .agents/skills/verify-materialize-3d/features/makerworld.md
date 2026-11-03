# MakerWorld

The MakerWorld tab embeds the MakerWorld site with an address bar and back, forward, and reload buttons. When the page is a model, the side panel shows its title, details, and files, and **Import to Library** clicks the page's own download control. A finished download lands in the app's library folder and shows in Model Library at once.

## Sub-features

- `makerworld-browser` covers the toolbar: `Go back`, `Go forward`, `Reload page`, the `MakerWorld address` field, and `button.makerworld-open-btn`. An `http://` or `https://` address must be on `makerworld.com`, or it is refused with "only makerworld.com URLs are allowed in the embedded browser".
- `makerworld-detect` covers the side panel. `.makerworld-chip` shows the page kind (`HOME`, `MODEL`, ...) and the import status (`IDLE`, `READY`, `DOWNLOADING`, `IMPORTED`, `ERROR`, upper-cased by CSS). `.makerworld-model-title` and the `Detected files` list fill in on a model page, and `.makerworld-import-btn` is enabled only then.
- `makerworld-import` covers **Import to Library**. It sets `DOWNLOADING`, then clicks the first download-like control on the page. A page with none sets `ERROR`, shows the reason as an alert, and renames the button **Retry Import**. The app has no login check of its own.
- `makerworld-files` covers where downloads land: `<data>/library/makerworld/<slug>/`, usually with the model ID in the slug, next to a `metadata.json` that lists only that folder's files. Each download captures its model and folder when it starts, so it lands there even after the user moves to another page. Overlapping downloads of one URL each reserve their own file name, such as `file (1).3mf` (PR 115). A later download keeps the model's earlier files in `metadata.json`. A malformed `metadata.json` gives a visible error and is not overwritten (PR 98).
- `makerworld-library` covers the Library row. A finished download emits `library:changed`, and Model Library shows a `library-card` at once. An existing folder keeps its row ID and first import date, and its details and file count refresh. Cards do not show the file count.
- `makerworld-linux-downloads` covers Tauri 2.12 and wry 0.57.1 (PR 105): on Linux, one failed download no longer fails the ones after it. The local-server tests in `src-tauri/src/makerworld/webkitgtk_downloads.rs` cover a failure followed by a success, and overlapping downloads.

## How to get to it (user POV)

- Click `MakerWorld` in the sidebar or the `MakerWorld` tab.
- Type a model URL into the address field and click Open, or browse to a model.
- Click **Import to Library**, then open Model Library.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- Internet access from the host.
- A successful download needs a page whose download control works in the embedded session. Model pages show no such control while signed out, and no machine has a signed-in embedded session. Report a successful import as unreachable with that prerequisite.

- **Open a model page (observed 2026-11-03).** Run `$S/wd.ts click "button[aria-label=MakerWorld]"`, `$S/wd.ts wait 'input[aria-label="MakerWorld address"]'`, `$S/wd.ts type 'input[aria-label="MakerWorld address"]' 'https://makerworld.com/en/models/1073764' --clear`, and `$S/wd.ts click 'button.makerworld-open-btn'`. Before, the chips read `HOME` and `IDLE` and Import is disabled. After about 20 seconds the chips read `MODEL` and `READY`, the title reads "Simple Headphone Hook dual color", `Detected files` lists five `3mf` files, and `$S/wd.ts wait '.makerworld-import-btn:not([disabled])'` succeeds.
- **Import while signed out (observed 2026-11-03).** Click `.makerworld-import-btn`. The chips read `MODEL` and `ERROR`, the alert reads "No download button or file link was found on the current MakerWorld page.", and the button reads "Retry Import". No `library` folder is created under the app data.
- **Import with a working download.** Click Import, then `$S/wd.ts wait '.makerworld-chip.status-imported' 60000`. Click `text=Model Library` and `$S/wd.ts wait "[data-testid=library-card]"`. Relaunch with `$S/wd.ts end` and `$S/wd.ts session`. The card count is unchanged. In `DB`, `library_models` has one row for the folder, and a second import keeps that row's ID and date while `metadata.json` lists both files. Not driven, see the preconditions.

## Gotchas

- `makerworld.com` answered `curl` from dev-substrate with HTTP 403, but the embedded browser loads it **(observed 2026-11-03)**. Do not judge reachability from `curl`.
- A click that opens a sign-in page instead of starting a download leaves the status at `DOWNLOADING` with no timeout. A reported failure sets `ERROR`.
- The local-server download tests do not prove the app path, because the address field accepts only `makerworld.com` URLs.
- The context panel's MakerWorld entry is static text.
