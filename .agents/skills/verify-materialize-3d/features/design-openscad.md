# Design (OpenSCAD)

The Design tab opens a `.scad` file into a code editor, a parameter panel, and a 3D preview. The model renders automatically when the file loads, when the user saves with Ctrl+S, and after a parameter change.

## Sub-features

- `design-empty` shows the "No file open" state with `Open .scad File`.
- `design-open` answers the native file dialog, then shows the filename in the design toolbar.
- `design-render` moves the status through `Extracting…`, `Rendering…`, and then `Ready` or `Error`, and loads the model into the viewer.
- `design-params` covers controls generated from the file's customizer comments.
- `design-edit-save` covers typing in the editor and saving with Ctrl+S, which re-renders.

## How to get to it (user POV)

- Click `Design` in the sidebar, or the `OpenSCAD` tab.
- Click `Open .scad File` (empty state) or `Open File` (design toolbar).

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- A fixture exists, for example `R=$(readlink -f ~/m3d-verify/current); mkdir -p $R/fixtures; printf '// cube\nsize = 20; // [5:50]\ncube([size, size, size / 2]);\n' > $R/fixtures/cube.scad`.
- For `design-render`, an `openscad` binary is installed at `/usr/bin/openscad`, at `/usr/local/bin/openscad`, on `PATH`, or pointed to by `OPENSCAD_CLI` (export it before `up`). The Linux host has none.

- **Empty state (observed 2026-09-25).** Run `$S/wd.ts click "button[aria-label=Design]"` and `$S/wd.ts text "[data-testid=design-tab-empty]"`. It reads "No file open … Open .scad File".
- **Open file (observed 2026-10-05).** Run `$S/wd.ts click "[data-testid=open-file-button]"` and `$S/m3d.sh file-dialog $R/fixtures/cube.scad`, then `$S/wd.ts wait "[data-testid=design-toolbar]"`. The toolbar shows `cube.scad`, `$S/wd.ts attr "[data-testid=design-toolbar] span[title]" title` prints the absolute path, and the editor shows the fixture's three lines.
- **Render without OpenSCAD (observed 2026-10-05).** Run `$S/wd.ts text "[data-testid=render-status]"`. It prints `Error`, and the page shows "Line 0: OpenSCAD CLI not found at /usr/bin/openscad. Install: ...". Report `design-render` as unreachable on this host and name the missing binary.
- **Render with OpenSCAD.** Run `$S/wd.ts wait "xpath=//*[@data-testid='render-status'][contains(., 'Ready')]" 60000`. Then `[data-testid=chip-model]` and `[data-testid=chip-size]` appear in the viewer, with the size reading `20 × 20 × 10 mm` for the fixture.
- **Parameters without OpenSCAD (observed 2026-09-25).** The panel reads "No parameters", because parameter extraction also needs the binary.
- **Parameters.** Run `$S/wd.ts count "[data-testid=parameter-panel] input"`. It is at least 1 for the fixture, labelled `size`. Changing it re-renders after about 300 ms, and `chip-size` changes.
- **Edit and save (observed 2026-10-05).** Run `$S/wd.ts click ".monaco-editor .view-lines"`, then `$S/wd.ts keys "// edit"`, then save with Ctrl+S (`$S/wd.ts keys $'s'`, where `` is Control). The fixture file on disk then contains `// edit`, and the status re-renders.

## Gotchas

- The file dialog is a native GTK window. WebDriver cannot see it, so always use `m3d.sh file-dialog`. Plain `xdotool type` into the location entry gets mangled by GTK's common-prefix autocompletion; for example, sibling run dirs `20260925-22…` produced `20260925-220260925-224835`. The helper sidesteps that. It cannot observe whether the dialog accepted the path, so always follow it with `wd.ts wait "[data-testid=design-toolbar]"`.
- There is no Render button. Rendering happens only on load, save, and parameter change.
- The rendered STL goes to a temporary directory under `/tmp`, not the app data dir, and no SQLite row is written. Prove a render through the viewer chips.
- The Monaco instance is not exposed on `window`. Drive it through the editor DOM, not script injection.
- Clicking `.monaco-editor textarea` fails with "element click intercepted". Click `.monaco-editor .view-lines` to focus the editor instead (observed 2026-10-05).
- Part designs never appear in the Design tab. Every design kind lists in the Signs view (`MainPanel.tsx:92`), see [signs](./signs.md) and [parts](./parts.md).
- Keep fixtures in `<run>/fixtures/`. They survive `down` alongside the evidence.
