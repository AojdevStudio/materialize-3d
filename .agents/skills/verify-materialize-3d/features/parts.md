# Parts

A part is a functional object that the agent writes as build123d code. A generation guest runs the script, a fresh inspection guest normalizes the result, and Rust measures the mesh. Each build gets mesh checks and advisory print checks per body, one check per requirement, slice and handoff checks, and an advisory `support_warning`. Only macOS bundles the CAD runtime, and no GUI shows a part yet, so on Linux the proof is the backend test suite.

## Sub-features

- `parts-build` covers the agent tools `describe_kind` and `build` for kind `part`.
- `parts-revise` covers `revise`, which applies a merge patch and records revision n+1.
- `parts-repair` covers repairing a failed build. There is no `repair` tool. The agent calls `build` again with the failed build's `lineage_id` (`src-tauri/src/agent/tests.rs:837-841`).
- `parts-checks` covers mesh, print, requirement, slice, and handoff checks, with print checks and `support_warning` advisory.
- `parts-store` covers the rows: `builds` (`check_plan part-checks-1`), `revisions` (`kind='part'`), `revision_exports` (`print_package` or `included_step`), and `agent_tool_calls`.
- `parts-gui` covers a part revision in the Signs view. It shows `part-pending` ("The part view arrives with pr8-gui.") and no approve or export (`DesignDetail.tsx:365-395`).

## How to get to it (user POV)

- On macOS, ask the agent for a part, in chat or over [MCP](./mcp.md).
- On Linux there is no user path. `CadRuntime::bundled()` returns an error off macOS (`cad_worker.rs:255-268`), and `part` is then dropped from the agent's kinds (`actions/mod.rs:288-292`).
- A part revision lists in the Signs view as a `sign-revision-row`. Its detail shows `part-pending`, see [signs](./signs.md).

## Driving it with wd.ts

Preconditions:

- `/dev/kvm`, `/dev/vhost-vsock`, and `qemu-system-x86_64` are present. Set `M3D_QEMU` to use another QEMU binary.
- The CAD runtime cache exists under `~/.cache/m3d-tool-cache/cad-runtime/amd64-<hash>/`. Without it, build it with `cad-runtime/build.sh amd64` (Docker) or `scripts/ci/cad-runtime-cache.sh`.
- `BAMBU_STUDIO_CLI` points at the AppRun in README.md's host facts.

- **Backend tests (observed 2026-10-05).** From `src-tauri/`, run:

  ```bash
  export BAMBU_STUDIO_CLI=<AppRun from README.md host facts>
  export M3D_CAD_RUNTIME=$(ls -d ~/.cache/m3d-tool-cache/cad-runtime/amd64-*)
  cargo test --lib --locked --features linux-cad-test fabrication::kinds::part::backend_tests -- --ignored --test-threads=1
  ```

  The result is 4 passed in 141 s. The first compile with the feature took 60 s. The tests prove four things:
  - The three proof parts verify on the real slicer, with every requirement measured.
  - An overhanging part verifies, with Bambu's support warning as advisory.
  - A failing fillet returns a bounded error at generate and records the revision.
  - A hostile script cannot change its own checks.
- **Linux app (observed 2026-10-05).** Over MCP, `describe_kind` lists the kind enum `["sign"]`. The agent never offers `part`, see [mcp](./mcp.md).
- **GUI part view (verified unreachable, 2026-10-05).** No wd.ts path exists. The prerequisites are pr8-gui, which is deferred, and a Linux runtime wired into `Workspace::new`. Report `parts-gui` as unreachable with those two preconditions.
- **macOS.** The 2026-10-05 9b smoke on the Mac mini built the design.md cable clip as a verified `part` over MCP, 15 of 15 checks, on a debug `--features e2e` build. That run was not repeated in this pass.

## Gotchas

- The tests leave `result.json` in the checkout root and in `src-tauri/`. Delete both before committing.
- CI runs the same suite in the `part-linux` job of `.github/workflows/cad-runtime.yml`.
- Part designs never appear in the Design tab. Every kind lists in the Signs view.
- Do not report the GUI path as verified through the backend tests. They prove the backend only.
