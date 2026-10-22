# Physically accept the P2S sign and desk clip

While this source branch is under development, the release-provided 3MF files are not yet available. Physical acceptance is pending. This procedure starts no print and records no completed outcome for Ossie.

The proposed distribution filenames are `Acceptance-Sign-P2S.3mf` and `Acceptance-Desk-Clip-P2S.3mf`. After [installed GUI acceptance](../verify-on-mac.md), the release engineer copies the exact software-verified exports to those names without changing their bytes. Keep the accompanying software evidence for the actual parameters, warnings, revision IDs, approved package hashes, and exported-file hashes.

1. Compare each file's full SHA-256 with its exported-file hash and approved package hash in the accompanying software evidence. Stop on a mismatch or missing evidence. In the folder containing the files, run this read-only command.

   ```bash
   shasum -a 256 Acceptance-Sign-P2S.3mf Acceptance-Desk-Clip-P2S.3mf
   ```

2. Open each exact file as a project in Bambu Studio `02.08.02.61`. Keep its project settings. Confirm the Bambu Lab P2S and a 0.4 mm nozzle.
3. Compare orientation, dimensions, and material assignments with the software evidence. Confirm the sign's face orientation and filament mapping. Review the exported warnings for each object. Follow any support requirements in those warnings. Do not guess support changes.
4. Slice both projects. Inspect the sign face and color placement in the layer preview, and the part's placement and any required supports. Retain screenshots and any new warnings. Stop on a discrepancy. Slicing does not authorize a print.
5. Only Ossie chooses whether to print either file. If he chooses to print, Ossie inspects the cooled sign for face finish, complete lettering, and color quality. He measures the actual part against the parameters and tolerances in the software evidence, and checks its fit on the intended desk. He records actual measurements, defects, and any deviations from the verified settings.

Ossie records pass, fail, or not printed for each exact file hash. Keep physical results separate from software checks. Do not mark acceptance checkboxes or change the app's print-result state on Ossie's behalf.

The longer [P2S test sign checklist](p2s-test-sign.md) covers a separate sign workflow. Its reference design does not define these exports' parameters or prove that either export was printed.
