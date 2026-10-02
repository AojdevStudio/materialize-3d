# Acceptance: print one three-color test sign on the P2S

This checklist takes one small sign from a chat request to a physical print. It is the human acceptance for the sign workflow. Automated checks prove a verified slice; only this checklist proves a print.

The sign is 80 × 50 × 2.6 mm: a white base with navy "HELLO", a teal rule, navy "3 COLOR TEST", a navy badge with "P2S" knocked out in white, and a teal dot. The finished face prints against the bed, so it reads normally from below and mirrored from above. The spec is `docs/acceptance/p2s-test-sign.json`; `fabrication::kinds::sign::tests::the_acceptance_sign_passes_every_geometry_check` keeps it valid.

## Before you start

- Materialize 3D installed from the release DMG (see `docs/install-macos.md`), an OpenAI or Anthropic API key, and Bambu Studio 02.08.02.61 on the same Mac.
- The P2S with white, navy, and teal PLA loaded, and a clean plate.

## Checklist

Mark each box yourself. None of these steps is automated.

1. **Request it in chat.** In the AI Assistant panel, send:

   > Make an 80 x 50 mm test sign for my P2S: white base, HELLO in large navy letters, a teal rule under it, "3 COLOR TEST" in smaller navy text, a small navy badge with P2S knocked out in white, and a teal dot in the top right.

   - [ ] The `build` card runs five steps and ends with `Verified N of N checks` and `Awaiting your approval (the assistant cannot approve)`.
   - [ ] The Signs view opens on the new revision.
   - If the layout differs from the description, correct it in chat ("make HELLO bigger"). A new revision appears; an earlier approval never carries over. To use the exact reference layout instead, choose **Build from spec file** in the Signs view and pick `docs/acceptance/p2s-test-sign.json`.

2. **Inspect it.** In the Signs view:
   - [ ] The preview reads correctly: HELLO, the rule, 3 COLOR TEST, the white P2S knocked out of the navy badge, the teal dot.
   - [ ] Sliced and verified is `Yes`, every check passes, including `slice.layer1_coverage`.
   - [ ] Print-tested is `Not tested`. Approval is `Pending for <hash>`.
   - [ ] Materials show slot 1 white, slot 2 navy, slot 3 teal.

3. **Approve it.**
   - [ ] Click `Approve rN for <hash>`. Approval reads `Approved for <hash>`.

4. **Export through the native Save dialog.**
   - [ ] Click `Export 3MF`, choose a folder in the macOS Save panel, and save.
   - [ ] In Terminal, `shasum -a 256 <saved file>` equals the package hash in the Signs view.

5. **Reopen in Bambu Studio.** Open the saved 3MF in Bambu Studio 02.08.02.61 and keep the project settings when asked.
   - [ ] Printer is `Bambu Lab P2S 0.4 nozzle`, process `0.20mm Standard @BBL P2S`.
   - [ ] The plate holds one object lying flat. From above, the text reads mirrored; that is expected for a face-down print.
   - [ ] The object has three parts: white on filament 1, navy on filament 2, teal on filament 3.
   - [ ] Map filaments 1 to 3 to the AMS slots that hold white, navy, and teal.
   - [ ] Slice, then open Preview at layer 1. The navy letters, badge, rule color, and teal dot appear in their colors on the first layer. From the bottom view the text reads normally.

6. **Print.**
   - [ ] Send the plate from Bambu Studio and watch the first layer go down.
   - [ ] After it cools, flip the sign: the face is flat, the three colors are flush, and every letter is complete.

7. **Record the result.** In the Signs view, open the revision and choose `Passed` or `Failed` under Record print result, with a short note. Print-tested changes only when you do this.

## What was automated before this checklist

Before release, the signed app installed from the DMG built this spec through its local MCP endpoint with isolated data: 27 of 27 checks passed and the revision waited for a person's approval, which the MCP endpoint cannot give. That run never approved, exported, opened Bambu Studio, or printed. Those steps, and the native Open and Save dialogs, belong to this checklist.
