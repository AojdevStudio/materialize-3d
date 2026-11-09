---
name: formal-verify-materialize-3d
description: Model-check, with TLC, what the in-app update's restart can cut off: the sidecar's turns and the slices Rust runs for them. Use when a change touches the build gate, update_install or install_when_idle, how a turn or a slice takes its pass, or when asked to recheck this model.
---

# Formal verification for Materialize 3D

A TLA+ model describes code where a bad order of events harms a user and tests rarely reach that order. TLC (the TLA+ model checker) tries every order of steps that the model allows.

`models/UpdateRestart.tla`. **Update now** waits for work, closes the build gate, installs, and restarts. The sidecar's chat work and the slices Rust runs for it race against it.

## Checks

`scripts/check.sh` runs each check and compares the verdict with the one recorded in its `CHECKS` table.

| Check | Property | Harm if it breaks | Recorded |
|---|---|---|---|
| `no-build-cut-off` | The restart never kills a slice or the sidecar's chat work, nor cuts its last commit. | A half-made 3MF, or a turn's agent killed mid-job. | holds |
| `gate-held-until-restart` | From the idle check to the restart, the gate is closed and no work runs. | Work starts that the restart then kills. | holds |
| `failed-update-reopens` | A failed update lets work start again. | The app refuses every send until it is quit. | holds |
| `update-wakes` | When work stops starting, a waiting update goes ahead. | **Update now** hangs with no work running. | holds |
| `update-not-starved` | A waiting update goes ahead even while work keeps starting. | **Update now** waits with no limit. | fails (F2) |

## Findings

These are failures of the current code, not of the models. Do not weaken a property or a model to make one pass. When a code change fixes one, change its recorded verdict to `holds` in `CHECKS`, and remove it here.

- **F2.** `BuildGate::close_when_idle` waits for `running == 0` but does not stop new work while it waits. Counterexample: the updater reaches its idle check, a turn enters first, the check sees it and sleeps, the turn ends and wakes the updater, and another turn or a slice enters before the next check. This repeats with no limit. Two passes that overlap in turn hold the update off the same way.

## Run

TLC needs Java 11 or newer and `tla2tools.jar` from the TLA+ v1.7.4 release (TLC 2.19). The script never downloads or installs anything. Point it at an existing jar:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar .agents/skills/formal-verify-materialize-3d/scripts/check.sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar .agents/skills/formal-verify-materialize-3d/scripts/check.sh --mutants
```

On a machine where installing is allowed, the jar is the `tla2tools.jar` asset of the v1.7.4 release at `https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4`. The script refuses any other jar by its SHA-256. Without TLC, say plainly that the models were not checked. Do not treat that as a pass.

CI runs both commands in `.github/workflows/formal-verification.yml` on each push to `main`, and each pull request from a branch in this repository, that changes a file listed in `models/sources.sha256` or this skill. Pull requests from forks and from Dependabot skip it, as they skip every self-hosted job. Before TLC, it fails when a listed file differs from its recorded hash. TLC reads only the models, so this is what stops the code from drifting away from them. Keep the workflow's `paths` list the same as the files in `models/sources.sha256`.

Exit 0 means every verdict matches the recorded one. Exit 1 means at least one differs. Exit 2 means TLC could not run. The whole run takes about a minute and a half. The last line names the folder that holds each check's TLC output, `<check>.out`.

`--mutants` runs each broken variant of the code, named by `Mutant` in `UpdateRestart.tla`. Each one must fail its check. This shows that the passing checks can fail.

| Mutant | The code change it stands for | Check it fails |
|---|---|---|
| `split-close` | `close_when_idle` reads `running`, then closes the gate in a second send. | `gate-held-until-restart` |
| `late-subscribe` | `borrow_and_update` moves after the idle check, so a build that ends in between is never heard. | `update-wakes` |
| `ungated-slice` | The sidecar's `slice` request no longer runs under `with_own_pass`. | `no-build-cut-off` |
| `ungated-turn` | A send no longer asks for the pass (`Busy.during` in `sidecar/src/busy.ts`). | `no-build-cut-off` |
| `early-release` | The sidecar gives its pass back while a task is still live. | `no-build-cut-off` |
| `guard-dropped` | `update_install` binds the `Closed` guard to `_`, which drops it before the restart. | `no-build-cut-off` |
| `guard-leaked` | An error path keeps the `Closed` guard alive. | `failed-update-reopens` |

## Does my change touch the models?

`models/sources.sha256` holds the hash of each source file the models describe, as it was when someone last confirmed the models against the code. See what changed since then, from the repo root:

```sh
s=.agents/skills/formal-verify-materialize-3d/models/sources.sha256
git diff --stat "$(git log -1 --format=%H -- "$s")" -- $(awk '{print $2}' "$s")
```

Then read each covered function that changed. Also look for new code that reaches the same state: a new caller of `BuildGate::enter_owned`, or a new long task that the restart could cut off.

| Model action | Code |
|---|---|
| `Enter`, `Leave` | `BuildGate::enter_owned` and `Drop for OwnedRunning` in `build_gate.rs`. For a slice, `take_pass` through `with_own_pass` in the `slice` request (`sidecar.rs`). For the sidecar's chat work, `take_pass` in `set_busy` (`sidecar.rs`), which `sidecar/src/busy.ts` asks for before a send commits (`Busy.during` in `sidecar/src/chat.ts`) and before work a crash cut off resumes (`busy.watch` in `sidecar/src/app.ts`), and `Drop for OwnedRunning` when it gives the pass back once no task is pending or running, after its last commit. A task that waits, sleeps, or holds a sign-in wait (`Busy.parked`) is not work: it resumes after a restart. `set_busy` refuses a request from a sidecar run that ended. A slice takes a pass of its own, since it can outlive the sidecar run that asked for it. A turn a sign-in lets go waits for the pass while an update installs (`Busy.duringWhenAllowed`). |
| `Downloaded`, `Top`, `CheckAndClose`, `CheckBusy`, `Wake` | `BuildGate::close_when_idle`. Its `subscribe`, `borrow_and_update`, one `send_if_modified`, and `changed().await`. |
| `Reopen` | `Drop for Closed`, on each error return of `install_when_idle`. |
| `Click`, `DownloadFails`, `InstallOk`, `InstallFails`, `Exit` | `update_install` and `install_when_idle` in `updater.rs`, then Tauri's `AppHandle::restart`, which ends in `process::exit(0)`. |

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

- Bounds: two tasks (a slice and a Studio turn), each holding at most one pass. Two update runs. `update-wakes` limits each task to two starts, so that work stops. It also assumes that each running task ends, and that the updater's wait loop keeps getting scheduled (the `Fairness` conjuncts in `UpdateRestart.tla`). The other checks have no limit on starts.
- Not covered: the download and its signature check, writes to the sidecar's store after the install (the store survives an exit), and the UI in `src/stores/updates.ts`.
