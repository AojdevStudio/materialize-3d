# Signs

The Signs view is where a person reviews a generated sign revision and decides whether to approve it for printing. It lists recent designs of every kind, parts included, and for one sign shows its revisions, the finished-face preview, three independent status axes (`Sliced and verified`, `Print-tested`, `Approval`), the checks table, materials and slicer, and the package and G-code SHA-256. Approve binds to the exact package hash shown on the button. Export 3MF and Record print result appear only after approval.

## Sub-features

- `signs-list` shows recent signs, one row per sign with its newest revision, or "No signs yet" on a fresh run.
- `signs-build` covers `Build from spec file`: the native Open dialog, static step progress (`Spec validated`, `Geometry built`, `Package written`, `Sliced`, `Verified`) with Cancel, the reuse notice, and the one-line build error.
- `signs-detail` covers the lineage rows, the preview, the three axes, checks in `sign-checks` (failed first, passing geometry checks grouped by name, Warning rows when present), materials, slicer, and the hashes `hash-package` and `hash-gcode` with Copy. Action errors show in `sign-action-error`.
- `signs-approve` covers `Approve rN for <7>…<4>`, enabled only for a verified build with a pending approval. On a failed build it is disabled and the failing check shows next to it. Approval must acknowledge exactly the recorded warnings, or it fails with `WarningsMismatch`.
- `signs-export` covers `Export 3MF` through the native Save dialog and `design_export` (format `print_package`), then shows the written path in `export-path`. Each export inserts a `revision_exports` row (`format`, `path`, `sha256`, `exported_at`).
- `signs-print` covers `Record print result` (`btn-print-passed` or `btn-print-failed` plus an optional note), labelled as a human physical test. It writes `print_status`, `print_note`, and `print_recorded_at`.
- `signs-open-event` covers the `designs:open` event (`{ revisionId }`), which switches to the view with that revision selected.
- `signs-part` covers a part revision in this view. It shows `part-pending` and no approve or export, see [parts](./parts.md).

## How to get to it (user POV)

- Click `Signs` in the sidebar, or the `Signs` tab in the workspace tab bar.
- Click a row in the list to open that sign. Click `Signs` in the header crumb to go back to the list.
- Click `Build from spec file` in the view header and pick a `.json` spec. With a sign open, the spec becomes that sign's next revision.

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- A validated Bambu Studio for building. Export `BAMBU_STUDIO_CLI` to the AppRun in README.md's host facts before `$S/m3d.sh up`, or choose it in Settings > Bambu Studio. The app looks in env `BAMBU_STUDIO_CLI`, then the setting `bambu_studio.path`, then the standard installs. Without a copy, the build fails with "<reason>. Download Bambu Studio 02.08.02.61 from ..., then choose it in Settings > Bambu Studio."
- The fixture in the run dir: `R=$(readlink -f ~/m3d-verify/current); mkdir -p $R/fixtures; cp src-tauri/tests/fixtures/signs/synthetic-back-shortly.json $R/fixtures/`.

- **Open the view (observed 2026-09-26).** Run `$S/wd.ts click "button[aria-label=Signs]"` and `$S/wd.ts wait "[data-testid=signs-view]"`. The sidebar's current item and the selected tab both read `Signs`. A fresh run reads "No signs yet. Build one from a spec file."
- **Build from spec (observed 2026-09-26).** Run `$S/wd.ts click "[data-testid=btn-build-from-spec]"`, `$S/m3d.sh file-dialog $R/fixtures/synthetic-back-shortly.json`, and `$S/wd.ts wait "[data-testid=build-progress]" 20000`. `[data-testid=btn-cancel-build]` sits next to the steps. Then `$S/wd.ts wait "[data-testid=sign-detail]" 300000`. The build took about 3 seconds on the Linux host, so the progress screenshot may already show most steps done.
- **Detail (observed 2026-09-26).** Run `$S/wd.ts wait "[data-testid=sign-preview]" 20000` before any screenshot, because the preview loads after the detail. `[data-testid=axis-build]` reads `Sliced and verified Yes 27 of 27 checks passed` (observed 2026-10-05), `axis-print` reads `Not tested set only by a human`, and `axis-approval` reads `Pending for <7>…<4>`. `$S/wd.ts attr "[data-testid=hash-package] code" title` prints the full package hash.
- **Approve (observed 2026-10-05).** Run `$S/wd.ts text "[data-testid=btn-approve]"` (`Approve r1 for <7>…<4>`), `$S/wd.ts click "[data-testid=btn-approve]"`, and `$S/wd.ts wait "[data-testid=btn-export]" 20000`. `axis-approval` reads `Approved for <7>…<4>, <time>`, and `axis-print` still reads `Not tested`.
- **Approval side effect (observed 2026-10-05).** Read `select approval_status, approved_package_sha256, acknowledged_warnings_json, print_status, build_id from revisions` from `DB`. It shows `approval_status = approved` and `acknowledged_warnings_json = "[]"`. `approved_package_sha256` equals the `hash-package` title, and `print_status` is `not_tested` (observed 2026-09-26). Then read `select build_status, failure_reason, check_plan from builds`. It shows `verified` and `sign-checks-1`.
- **Persistence (observed 2026-10-05).** Run `$S/wd.ts end`, `$S/wd.ts session`, click `Signs`, then click `[data-testid=sign-revision-row]`. `axis-approval` still reads `Approved for <7>…<4>, <time>`, `btn-approve` is gone, and `btn-export` is present.
- **Record print result (observed 2026-10-05).** Run `$S/wd.ts type "[aria-label='Print result note']" "first layer clean"` and `$S/wd.ts click "[data-testid=btn-print-passed]"`. `DB` shows `print_status = passed` with `print_note` set. `axis-print` reads `Passed <time>, <note>` (observed 2026-09-26).
- **Rebuild the same spec (observed 2026-10-05).** Build the fixture again with the sign open. `[data-testid=build-reused]` reads "Nothing to build: r1 uses an identical verified build. Opened it.", and the lineage still has one `sign-revision-row`.
- **Export (observed 2026-10-05).** Run `$S/wd.ts click "[data-testid=btn-export]"`, which opens a native GTK window titled `Save File`. Run `$S/m3d.sh file-dialog $R/fixtures/sign-export.3mf` with a path that does not exist yet, so the helper answers `Save File`. Then `$S/wd.ts text "[data-testid=export-path]"` reads "Wrote <path>". The file's `sha256sum` equals the package hash, and `DB` gains a `revision_exports` row with format `print_package`.
- **Warnings.** A build with advisory warnings shows Warning rows in the checks, and `axis-build` adds ", N warnings". Approval then acknowledges exactly those warnings.
- **Failed build.** A spec whose build fails a check shows `axis-build` as `No sliced, N of M checks passed`, a disabled `btn-approve`, and `[data-testid=approve-blocked]` with the failing check and its detail. Covered by `src/tests/designs-view.test.tsx`.

## Gotchas

- Take screenshots only after `[data-testid=sign-preview]` exists. A shot right after `sign-detail` appears shows an empty preview column.
- The Save dialog blocks the app until it closes. Answer it with `m3d.sh file-dialog` right after clicking `btn-export`.
- The app run leaves no `result.json` in the checkout (observed 2026-10-05). The part backend tests do, see [parts](./parts.md).
- `slicer unavailable` now means only that preset resolution failed. A missing Bambu Studio gives the longer download message in the preconditions.
- Build state lives in `builds` (`build_status` is `building`, `verified`, `failed`, or `invalid`, plus `failure_reason` and `check_plan`), joined to `revisions` by `revisions.build_id`.
- `Build from spec file` with a design open adds a revision to that design. To build a new sign, relaunch so nothing is selected first.
- The fixture has no `title`, so the sign is listed as `Untitled sign` and the export default name is `Untitled sign-r1.3mf`.
- `design_get` re-hashes an approved package each time a revision opens. A package changed on disk turns the approval `Void` with the reason, marks the build `invalid`, and export disappears.
- The context panel entry for Signs is static text. It does not list signs.
