# Parts

A part is a functional object generated as build123d code. A generation guest runs the script, a fresh inspection guest normalizes the result, and Rust measures the mesh. The Signs view includes a part detail with a render, revisions, measured requirements, warnings, approval, and 3MF export. PR 34 added this GUI. Its presence in source does not establish installed-release acceptance.

## Sub-features

- `parts-build` covers the agent tools `describe_kind` and `build` for kind `part`.
- `parts-revise` covers `revise`, which applies a merge patch and records revision n+1.
- `parts-repair` covers another `build` with the failed build's `lineage_id`. There is no `repair` tool.
- `parts-checks` covers mesh, print, requirement, slice, and handoff checks. Print checks and `support_warning` are advisory.
- `parts-store` covers `builds` with `check_plan part-checks-1`, `revisions` with `kind='part'`, `revision_exports`, and `agent_tool_calls`.
- `parts-gui` covers `part-detail`, `part-render`, `part-revisions`, and `part-requirements`. **Show all checks** expands the shared `sign-checks` table. `part-warnings` lists warnings, and `part-blocked` explains an unapprovable build.
- `parts-approve` uses `btn-approve` to bind the package hash and exactly the listed warnings. `part-action-error` shows an action failure.
- `parts-export` uses `btn-export`, the native Save dialog, and `export-path`. The exported 3MF includes `Metadata/part.step`. The backend supports `included_step` export, but this GUI offers **Export 3MF** only.

## How to get to it (user POV)

- On macOS, ask the assistant for a part in chat. The installed app needs its bundled, verified CAD helper and runtime.
- Open the resulting revision in the Signs view. Parts share this list with signs, but use their own detail.
- Review the render, requirements, and checks. Review warnings before approval. After approval, export through the Save dialog.
- A part does not appear in the OpenSCAD Design tab.

## Driving it with wd.ts

The ordinary Linux debug app cannot build parts. `CadRuntime::bundled()` supplies a runtime only on macOS, so the ordinary Linux app omits `part` from its available kinds. The `linux-cad-test` feature is a backend test route, not installed macOS GUI proof.

For installed-release acceptance, follow [Verify the installed Mac app](../../../../docs/verify-on-mac.md). It specifies OpenAI prompts, the part detail, approval, native Save, full hash comparison, Bambu Studio P2S 0.4 mm slicing, and persistence. That run is pending for 0.2.0. The native Mac automation route is under audit. Record an unmet prerequisite instead of claiming a substitute path passed.

On an e2e debug Mac build with a verified runtime, these handles describe the GUI path from source. They have not been run for this documentation update.

1. Complete onboarding, select the provider and model, and store the key through Settings.
2. Send the part request through `chat-input` and `chat-send`. Wait for `part-detail`, then `part-render` and `part-requirements`.
3. Read the measured requirements and revision buttons in `part-revisions`. Click **Show all checks** and read `sign-checks`. Capture `part-warnings` when present.
4. Click `btn-approve` only after review. Confirm the approved revision and warning count. Click `btn-export` and answer the native Save dialog.
5. Read `export-path`, hash the exported file, and compare it with the revision's approved package hash. Confirm the `revision_exports` row with format `print_package`.
6. Relaunch on the same data. Confirm the revision, approval, and OpenAI settings persist. A failed build must show `part-blocked` and no approval control.

For backend tests on Linux, provide `/dev/kvm`, `/dev/vhost-vsock`, `qemu-system-x86_64`, the pinned amd64 CAD runtime, and Bambu Studio 02.08.02.61. `M3D_CAD_RUNTIME` must name one exact runtime directory. From `src-tauri`, run this existing suite.

```bash
cargo test --lib --locked --features linux-cad-test fabrication::kinds::part::backend_tests -- --ignored --test-threads=1
```

The suite covers the proof parts, advisory support warnings, a failing fillet, and a hostile script. Historical backend observations from 2026-10-05 are not a result for the current release candidate.

## Gotchas

- A debug `mac.ts` run uses the e2e endpoint and scripted dialogs. It cannot control the installed release binary or establish release GUI acceptance.
- A missing or rejected bundled runtime makes the part kind unavailable. Acceptance must not depend on a developer cache or Python environment.
- Advisory warnings can coexist with a verified build. Approval acknowledges the exact warning list.
- Only a person records a physical print result. Passing mesh, slice, or GUI checks leaves Print-tested unchanged.
- Backend tests may leave probe output in the checkout. Compare Git status before and after, and preserve unrelated files.
