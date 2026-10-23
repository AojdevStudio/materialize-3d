# Physically accept the P2S sign and desk clip

Use this procedure only if the [Releases page](https://github.com/AojdevStudio/materialize-3d/releases) has the actual approved 3MF exports and the required software acceptance record attached to the release. Physical acceptance remains pending and each object is not printed unless Ossie records its print and inspection. This procedure starts no print and records no completed outcome for Ossie.

The proposed distribution filenames are `Acceptance-Sign-P2S.3mf` and `Acceptance-Desk-Clip-P2S.3mf`. Availability depends on actual approved exports attached to the release. After [installed GUI acceptance](../verify-on-mac.md), the release engineer copies the exact software-verified exports to those names without changing their bytes. The attached software acceptance record must identify the actual parameters, warnings, revision IDs, approved package hashes, and exported-file hashes. Excluded candidates are not acceptance exports.

1. Compare each downloaded file's full SHA-256 with its exported-file hash and approved package hash in the attached software acceptance record. Stop on a mismatch or missing evidence. In the folder containing the files, run this read-only command.

   ```bash
   shasum -a 256 Acceptance-Sign-P2S.3mf Acceptance-Desk-Clip-P2S.3mf
   ```

2. Open each exact file as a project in Bambu Studio `02.08.02.61`. Keep its project settings. Confirm the Bambu Lab P2S and a 0.4 mm nozzle.
3. Compare orientation, dimensions, and material assignments with the software evidence. Confirm the sign's face orientation and filament mapping. Review the exported warnings for each object. Follow any support requirements in those warnings. Do not guess support changes.
4. Slice both projects. Inspect the sign face and color placement in the layer preview, and the part's placement and any required supports. Retain screenshots and any new warnings. Stop on a discrepancy. Slicing does not authorize a print.
5. Only Ossie chooses whether to print either file. If he chooses to print, Ossie inspects the cooled sign for face finish, complete lettering, and color quality. He measures the actual part against the parameters and tolerances in the software evidence, and checks its fit on the intended desk. He records actual measurements, defects, and any deviations from the verified settings.

Ossie records pass, fail, or not printed for each exact file hash. Keep physical results separate from software checks. Do not mark acceptance checkboxes or change the app's print-result state on Ossie's behalf.

The longer [P2S test sign checklist](p2s-test-sign.md) covers a separate sign workflow. Its reference design does not define these exports' parameters or prove that either export was printed.
