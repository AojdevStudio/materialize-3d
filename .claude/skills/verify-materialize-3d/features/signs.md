# Signs

The Signs view is where a person reviews a generated sign revision and decides whether to approve it for printing. It lists recent signs, and for one sign shows its revisions, the finished-face preview, three independent status axes (`Sliced and verified`, `Print-tested`, `Approval`), the checks table, materials and slicer, and the package and G-code SHA-256. Approve binds to the exact package hash shown on the button. Export 3MF and Record print result appear only after approval.

## Sub-features

- `signs-list` shows recent signs, one row per sign with its newest revision, or "No signs yet" on a fresh run.
- `signs-build` covers `Build from spec file`: the native Open dialog, static step progress (`Spec validated`, `Geometry built`, `Package written`, `Sliced`, `Verified`) with Cancel, the reuse notice, and the one-line build error.
- `signs-detail` covers the lineage rows, the preview, the three axes, checks (failed first, passing geometry checks grouped by name), materials, slicer, and hashes with Copy.
- `signs-approve` covers `Approve rN for <7>…<4>`, enabled only for a verified build with a pending approval. On a failed build it is disabled and the failing check shows next to it.
- `signs-export` covers `Export 3MF` through the native Save dialog and `sign_export`, then shows the written path.
- `signs-print` covers `Record print result` (Passed or Failed plus an optional note), labelled as a human physical test.
- `signs-open-event` covers the `signs:open` event (`{ revisionId }`), which switches to the view with that revision selected.

## How to get to it (user POV)

- Click `Signs` in the sidebar, or the `Signs` tab in the workspace tab bar.
- Click a row in the list to open that sign. Click `Signs` in the header crumb to go back to the list.
- Click `Build from spec file` in the view header and pick a `.json` spec. With a sign open, the spec becomes that sign's next revision.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- A validated Bambu Studio for building. Export `BAMBU_STUDIO_CLI=<path to the Bambu Studio 02.08.02.61 AppRun>` before `$S/m3d.sh up`, or the build fails with `slicer unavailable`.
- The fixture in the run dir: `R=$(readlink -f ~/m3d-verify/current); mkdir -p $R/fixtures; cp src-tauri/tests/fixtures/signs/synthetic-back-shortly.json $R/fixtures/`.

- **Open the view (observed 2026-09-26).** Run `$S/wd.ts click "button[aria-label=Signs]"` and `$S/wd.ts wait "[data-testid=signs-view]"`. The sidebar's current item and the selected tab both read `Signs`. A fresh run reads "No signs yet. Build one from a spec file."
- **Build from spec (observed 2026-09-26).** Run `$S/wd.ts click "[data-testid=btn-build-from-spec]"`, `$S/m3d.sh file-dialog $R/fixtures/synthetic-back-shortly.json`, and `$S/wd.ts wait "[data-testid=build-progress]" 20000`. `[data-testid=btn-cancel-build]` sits next to the steps. Then `$S/wd.ts wait "[data-testid=sign-detail]" 300000`. The build took about 3 seconds on the Linux host, so the progress screenshot may already show most steps done.
- **Detail (observed 2026-09-26).** Run `$S/wd.ts wait "[data-testid=sign-preview]" 20000` before any screenshot, because the preview loads after the detail. `[data-testid=axis-build]` reads `Yes 26 of 26 checks passed, <time>`, `axis-print` reads `Not tested set only by a human`, and `axis-approval` reads `Pending for <7>…<4>`. `$S/wd.ts attr "[data-testid=hash-package] code" title` prints the full package hash.
- **Approve (observed 2026-09-26).** Run `$S/wd.ts text "[data-testid=btn-approve]"` (`Approve r1 for <7>…<4>`), `$S/wd.ts click "[data-testid=btn-approve]"`, and `$S/wd.ts wait "[data-testid=btn-export]" 20000`. `axis-approval` reads `Approved for <7>…<4>, <time>`, and `axis-print` still reads `Not tested`.
- **Approval side effect (observed 2026-09-26).** Read `select approval_status, approved_sha256, print_status from sign_revisions` from `DB`. It shows `approved`, the same hash as the `hash-package` title, and `not_tested`.
- **Persistence (observed 2026-09-26).** Run `$S/wd.ts end`, `$S/wd.ts session`, click `Signs`, then click `[data-testid=sign-revision-row]`. `axis-approval` still reads `Approved`, `btn-approve` is gone, and `btn-export` is present.
- **Record print result (observed 2026-09-26).** Run `$S/wd.ts type "[aria-label='Print result note']" "note"` and `$S/wd.ts click "[data-testid=btn-print-passed]"`. `axis-print` reads `Passed <time>, note`. `DB` shows `print_status = passed` with the note.
- **Rebuild the same spec (observed 2026-09-26).** Build the fixture again with the sign open. `[data-testid=build-reused]` reads "Identical revision r1 already existed. Opened it.", and the lineage still has one `sign-revision-row`.
- **Export (not reachable with the helper, 2026-09-26).** `$S/wd.ts click "[data-testid=btn-export]"` opens a native GTK window titled `Save File`. `$S/m3d.sh file-dialog` looks only for `Open File` and needs an existing path, so it exits with "no Open File dialog on the display". Report `signs-export` as unverified live; the Rust export path is unit-tested.
- **Failed build.** A spec whose build fails a check shows `axis-build` as `No sliced, N of M checks passed`, a disabled `btn-approve`, and `[data-testid=approve-blocked]` with the failing check and its detail. Covered by `src/tests/signs-view.test.tsx`.

## Gotchas

- Take screenshots only after `[data-testid=sign-preview]` exists. A shot right after `sign-detail` appears shows an empty preview column.
- The Save dialog blocks the app until it closes. Drive export last in a session, then run `$S/m3d.sh down`.
- Bambu Studio writes `result.json` into the app's working directory, which is the checkout root, during each slice. Delete it before committing from that checkout.
- The fixture has no `title`, so the sign is listed as `Untitled sign` and the export default name is `Untitled sign-r1.3mf`.
- `sign_get` re-hashes an approved package each time a revision opens. A package changed on disk turns the approval `Void` with the reason, and export disappears.
- The context panel entry for Signs is static text. It does not list signs.
