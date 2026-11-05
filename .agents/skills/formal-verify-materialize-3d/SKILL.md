---
name: formal-verify-materialize-3d
description: Model-check, with TLC, what the in-app update's restart can cut off (builds, STL slices, print_queue.json) and whether the print queue's auto-send can send one job twice. Use when a change touches the build gate, update_install or install_when_idle, how a build or slice starts, persist_queue, or auto_send_pending_job, or when asked to recheck these models.
---

# Formal verification for Materialize 3D

Two TLA+ models describe code where a bad order of events harms a user and tests rarely reach that order. TLC (the TLA+ model checker) tries every order of steps that the models allow.

- `models/UpdateRestart.tla`. **Update now** waits for builds, closes the build gate, backs up, installs, and restarts. Builds and STL slices race against it, and so do print queue writes.
- `models/AutoSend.tla`. Two auto-send runs race to send the first Pending job in the print queue to the printer, across reconnects and a printer switch.

## Checks

`scripts/check.sh` runs each check and compares the verdict with the one recorded in its `CHECKS` table.

| Check | Property | Harm if it breaks | Recorded |
|---|---|---|---|
| `no-build-cut-off` | The restart never kills a build or a slice. | A half-made build or 3MF, and the user's work is lost. | holds |
| `gate-held-until-restart` | From the idle check to the restart, the gate is closed and no build runs. | A build starts that the restart then kills. | holds |
| `failed-update-reopens` | A failed update lets builds start again. | The app refuses every build until it is quit. | holds |
| `update-wakes` | When builds stop starting, a waiting update goes ahead. | **Update now** hangs with no build running. | holds |
| `queue-file-at-restart` | The restart never leaves `print_queue.json` half written. | The queue is empty after the restart. | fails (F1) |
| `update-not-starved` | A waiting update goes ahead even while builds keep starting. | **Update now** waits with no limit. | fails (F2) |
| `job-sent-once` | The app sends each queued job to the printer at most once, across reconnects and a printer switch. | The printer gets one job twice. | holds |
| `one-run-at-a-time` | At most one auto-send run works on the queue, across reconnects and a printer switch. | Two uploads of one job write the same file on the printer. | holds |
| `send-only-when-wanted` | A `project_file` goes out only to a live printer that still reports IDLE, and only for a job still Pending in the queue. | The printer gets a job while it runs another print or before it reports on a new session, or a job the user removed during its upload. | holds |

## Findings

These are failures of the current code, not of the models. Do not weaken a property or a model to make one pass. When a code change fixes one, change its recorded verdict to `holds` in `CHECKS`, and remove it here.

- **F1.** `persist_queue` (`src-tauri/src/print_queue.rs`) holds the queue lock across `std::fs::write`, which truncates the file and then writes it. The updater holds that lock only for the backup. Counterexample: the backup and the install finish. Then the printer's auto-send calls `update_job_status`, which truncates `print_queue.json`. Then `app.restart()` calls `process::exit`. A failed write leaves the same partial file and drops the lock, so the restart need not even race a write. At the next launch, `load_queue` cannot parse the file, logs a warning, and starts with an empty queue. The backup still holds the queue as it was at the backup.
- **F2.** `BuildGate::close_when_idle` waits for `running == 0` but does not stop new builds while it waits. Counterexample: the updater reaches its idle check, a build enters first, the check sees it and sleeps, the build ends and wakes the updater, and another build enters before the next check. This repeats with no limit. Two builds that overlap in turn hold the update off the same way.

## Run

TLC needs Java 11 or newer and `tla2tools.jar` from the TLA+ v1.7.4 release (TLC 2.19). The script never downloads or installs anything. Point it at an existing jar:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar .agents/skills/formal-verify-materialize-3d/scripts/check.sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar .agents/skills/formal-verify-materialize-3d/scripts/check.sh --mutants
```

On a machine where installing is allowed, the jar is the `tla2tools.jar` asset of the v1.7.4 release at `https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4`. The script refuses any other jar by its SHA-256. Without TLC, say plainly that the models were not checked. Do not treat that as a pass.

CI runs both commands in `.github/workflows/formal-verification.yml` on each push to `main`, and each pull request from a branch in this repository, that changes a file listed in `models/sources.sha256` or this skill. Pull requests from forks and from Dependabot skip it, as they skip every self-hosted job. Before TLC, it fails when a listed file differs from its recorded hash. TLC reads only the models, so this is what stops the code from drifting away from them. Keep the workflow's `paths` list the same as the files in `models/sources.sha256`.

Exit 0 means every verdict matches the recorded one. Exit 1 means at least one differs. Exit 2 means TLC could not run. The whole run takes about a minute and a half. The last line names the folder that holds each check's TLC output, `<check>.out`.

`--mutants` runs each broken variant of the code, named by `Mutant` in `UpdateRestart.tla` and `AutoSend.tla`. Each one must fail its check. This shows that the passing checks can fail.

| Mutant | The code change it stands for | Check it fails |
|---|---|---|
| `split-close` | `close_when_idle` reads `running`, then closes the gate in a second send. | `gate-held-until-restart` |
| `late-subscribe` | `borrow_and_update` moves after the idle check, so a build that ends in between is never heard. | `update-wakes` |
| `ungated-slice` | `slice_model` no longer calls `builds.enter()`. | `no-build-cut-off` |
| `guard-dropped` | `update_install` binds the `Closed` guard to `_`, which drops it before the restart. | `no-build-cut-off` |
| `guard-leaked` | An error path keeps the `Closed` guard alive. | `failed-update-reopens` |
| `unguarded` | The claim in `auto_send_pending_job` no longer checks `queue_held`. | `one-run-at-a-time` |
| `released-on-switch` | `end_connection` frees `queue_held`, so a new connection's run can start beside an old one still uploading. | `one-run-at-a-time` |
| `no-recheck` | `send_project_file` publishes without rechecking the connection, the readiness, and the job after the upload. | `send-only-when-wanted` |

No single mutant fails `job-sent-once`. Two guards keep it: `queue_held`, and the recheck in `send_project_file`, which marks the job Submitted under the same lock as the publish. Before that recheck, `released-on-switch` sent one job twice.

## Does my change touch the models?

`models/sources.sha256` holds the hash of each source file the models describe, as it was when someone last confirmed the models against the code. See what changed since then, from the repo root:

```sh
s=.agents/skills/formal-verify-materialize-3d/models/sources.sha256
git diff --stat "$(git log -1 --format=%H -- "$s")" -- $(awk '{print $2}' "$s")
```

Then read each covered function that changed. Also look for new code that reaches the same state: a new caller of `builds.enter()`, a new long task that the restart could cut off, a new writer of the print queue, or a new trigger of `auto_send_pending_job`.

| Model action | Code |
|---|---|
| `Enter`, `Leave` | `BuildGate::enter` and `Drop for Running` in `build_gate.rs`. Callers: `build_as` in `pipeline.rs`, `slice_model` in `commands.rs`. |
| `Downloaded`, `Top`, `CheckAndClose`, `CheckBusy`, `Wake` | `BuildGate::close_when_idle`. Its `subscribe`, `borrow_and_update`, one `send_if_modified`, and `changed().await`. |
| `Reopen` | `Drop for Closed`, on each error return of `install_when_idle`. |
| `Click`, `DownloadFails`, `BackupOk`, `BackupFails`, `InstallOk`, `InstallFails`, `Exit` | `update_install` and `install_when_idle` in `updater.rs`, then Tauri's `AppHandle::restart`, which ends in `process::exit(0)`. |
| `WriteBegin`, `WriteEnd`, `WriteFails` | `persist_queue` in `print_queue.rs`. |
| `Spawn`, `Claim`, `UploadOk`, `UploadFails`, `SendOk`, `SendSkips`, `SendFails`, `Release` | `auto_send_pending_job`, `submit_job`, and `send_project_file` in `printer/mod.rs`. `spawn_auto_send` starts each run, from `handle_publish` and from `advance_queue`, which `add_to_queue` in `commands.rs` calls. |
| `Remove` | `remove_job` in `print_queue.rs`, through `remove_from_queue` in `commands.rs`. |
| `Report`, `Drop`, `Connect`, `Switch` | `handle_publish`, `set_state`, `set_connected`, and `end_connection` (through `disconnect` and `start`) in `printer/mod.rs`. |

Record new hashes only after you confirm that the models describe the code at HEAD:

```sh
sha256sum $(awk '{print $2}' "$s") >| "$s.new" && mv "$s.new" "$s"
```

## Read a result

A check whose verdict differs from the recorded one is the signal. Read its `<check>.out`, and read the trace with the pstack `/statechart` skill. It tells an invariant violation as its shortest path in plain words, and it charts a passing model's states. Its first run can install its own TLC. Where installing is not allowed, read the TLC trace in `<check>.out` yourself.

Replay each step of the trace against the code.

- A step that cannot happen in the code means the model is wrong. Fix the model, and say what was wrong.
- Every step can happen means the code breaks the property. Report it in the code's words, as a finding like F1 and F2. Do not change product code unless the user asks.

## Change the models with the code

Keep each model action one indivisible step in the code. When the code changes on purpose, change the action that describes it, from the code and not from the result. Change a property only when the promise changed on purpose, and cite the doc comment, test, or commit that says so. A new property that holds needs a mutant that fails it. Then run the checks, run `--mutants`, and record the new hashes.

## Scope

- Bounds: two build tasks (a pipeline build and an STL slice), each holding at most one pass. Two update runs. One print queue writer. For auto-send, two overlapping runs, two jobs, and one printer switch. `update-wakes` limits each build task to two starts, so that builds stop. It also assumes that each running build ends, that a started queue write ends or fails, and that the updater's wait loop keeps getting scheduled (the `Fairness` conjuncts in `UpdateRestart.tla`). The other `UpdateRestart` checks have no limit on starts.
- Each run of `persist_queue` is lock, truncate, write, unlock. The model joins lock and truncate into one step. A truncated file and a half-written file are both `partial`.
- Not covered: the download and its signature check, the backup's contents, SQLite writes after the backup (the database survives an exit), the UI in `src/stores/updates.ts`, and what the printer does with a second `project_file` command. Other long tasks that do not take a build pass, such as an OpenSCAD render or a MakerWorld download, are not in the model.
