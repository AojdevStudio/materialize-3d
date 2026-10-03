# Self-hosted CI runners

Two jobs in `.github/workflows/cad-runtime.yml` run on machines Ossie owns: all CI that touches the CAD runtime is self-hosted (Ossie, 2026-10-02, in the CAD engine design). The Mac job could not run anywhere else, because hosted macOS runners are themselves Virtualization-framework VMs without nested virtualization and cannot boot the CAD guest. Every other job (`ci.yml`, `pullfrog.yml`) runs on GitHub-hosted runners.

| Job (check-run name) | Runner | Host | Labels | What it proves |
|---|---|---|---|---|
| `CAD runtime images reproduce` | `dev-substrate-materialize-3d` | `dev-substrate`, an x86_64 Ubuntu 24.04 VM (8 vCPUs, `/dev/kvm`) | `self-hosted`, `Linux`, `X64`, `m3d-linux-kvm` | Two clean builds per architecture (`cad-runtime/reproduce.sh arm64` and `amd64`) give identical digests that match `cad-runtime/pins-<arch>.json`. Uploads the arm64 runtime for the next job. |
| `CAD helper restriction tests` | `mac-mini-m4-materialize-3d-cad` | the Mac mini (Apple M4, macOS 26) | `self-hosted`, `macOS`, `ARM64`, `m3d-mac-vz` | The helper's tests and clippy, the runtime against the helper's compiled-in pins, the ten restriction tests on the real Virtualization framework, and the cable clip through both guests. |

## Keeping fork pull requests off these machines

The repository is public, so a pull request from a fork could try to run code on these runners. A user-owned repository has no runner groups to limit which workflows may use a runner, and a fork's pull request runs the workflow files from its own head, so a fork can delete an `if:` or add its own self-hosted workflow. Two guards stand in the way:

1. **The fork approval policy.** No workflow run from a fork starts until a maintainer approves it. A maintainer approves a fork's run only after reading every change under `.github/`; agents never approve one. This is the guard that holds against a fork that edits the workflows.
2. **The same-repo condition.** Every self-hosted job runs only on a push to `main`, a manual dispatch, or a pull request whose head branch is in this repository:

   ```yaml
   if: >-
     github.event_name == 'push' || github.event_name == 'workflow_dispatch' ||
     (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)
   ```

   An approved fork run that leaves the workflow alone still skips both jobs. A new self-hosted job must carry the same condition.

The policy, read back on 2026-10-03:

```bash
gh api repos/AojdevStudio/materialize-3d/actions/permissions/fork-pr-contributor-approval
# {"approval_policy":"all_external_contributors"}
```

Read it again before trusting these notes; nothing in CI changes it. Same-repository pull requests, Dependabot's included, do run on these machines. Only people and bots with write access can open one.

## Host setup

### Linux: `dev-substrate`

- Runner 2.337.0 in `/home/ossie/actions-runner-materialize-3d`, as the user `ossie`, installed with the runner's own `svc.sh` as the systemd service `actions.runner.AojdevStudio-materialize-3d.dev-substrate-materialize-3d.service`. The tarball's sha256 matched the one in the release notes.
- `ossie` is in the `docker` group. Packages the job needs beyond Ubuntu's base: `docker.io`, `docker-buildx` (for `--platform` and the tar exporter), and `qemu-user-static`, which registers the arm64 binfmt handler at boot with the `F` flag so containers can run it.
- The kernel tarball and its signature stay cached in `~/.cache/m3d-tool-cache/kernel/` between runs; every build checks the sha256 pin and the kernel.org signature again.
- Docker's build cache is bounded by the daemon's garbage collector (`/etc/docker/daemon.json`, `defaultKeepStorage` 20 GB). The job builds with `--no-cache`, so each run adds fresh cache records for that collector to reclaim.

### Mac: the Mac mini

- Runner 2.337.0 in `~/actions-runners/materialize-3d-cad-macos-arm64/actions-runner`, as `aojdevstudio`, installed with `svc.sh` as the LaunchAgent `actions.runner.AojdevStudio-materialize-3d.mac-mini-m4-materialize-3d-cad` in the logged-in desktop session. A `README.md` beside it follows the layout of the mini's other runners.
- Its `PATH` (`.path`) is `/opt/homebrew/bin:~/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`: cargo from rustup, `jq`, `codesign`, and `shasum` come from there.
- The job signs the helper ad hoc with the virtualization entitlement. It holds no Developer ID material and no secrets; release signing happens only in `scripts/release/build-macos.sh`.
- The runner named `mac-mini-m4-materialize-3d` in `~/actions-runners/materialize-3d-macos-arm64/` belongs to the archived repository (`AojdevStudio/materialize-3d-archive`) and takes no jobs from this one.

### Registering a runner again

Registration needs a short-lived token. Pass it through the environment so it stays out of `argv` and the shell history:

```bash
gh api -X POST repos/AojdevStudio/materialize-3d/actions/runners/registration-token --jq .token \
  | ssh <host> 'IFS= read -r t; cd <runner dir> && ACTIONS_RUNNER_INPUT_TOKEN="$t" ./config.sh --unattended \
      --url https://github.com/AojdevStudio/materialize-3d --name <name> --labels <label> --work _work'
```

Then install the service (`sudo ./svc.sh install ossie && sudo ./svc.sh start` on Linux, `./svc.sh install && ./svc.sh start` on the Mac) and check `gh api repos/AojdevStudio/materialize-3d/actions/runners`.

## Not done here

Neither job is a required check yet. Adding them to the `main: reviewed and green` ruleset is Ossie's call once both have passed on `main`.
