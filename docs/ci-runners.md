# Self-hosted CI runners

Two jobs in `.github/workflows/cad-runtime.yml` run on machines Ossie owns: all CI that touches the CAD runtime is self-hosted (Ossie, 2026-10-02, in the CAD engine design). The Mac job could not run anywhere else, because hosted macOS runners are themselves Virtualization-framework VMs without nested virtualization and cannot boot the CAD guest. Every other job (`ci.yml`, `pullfrog.yml`) runs on GitHub-hosted runners.

| Job (check-run name) | Runner | Host | Labels | What it proves |
|---|---|---|---|---|
| `CAD runtime images reproduce` | `dev-substrate-materialize-3d` | `dev-substrate`, an x86_64 Ubuntu 24.04 VM (8 vCPUs, `/dev/kvm`) | `self-hosted`, `Linux`, `X64`, `m3d-linux-kvm` | Two clean builds per architecture (`cad-runtime/reproduce.sh arm64` and `amd64`) give identical digests that match `cad-runtime/pins-<arch>.json`. Uploads the arm64 runtime for the next job. |
| `CAD helper restriction tests` | `mac-mini-m4-materialize-3d-cad` | the Mac mini (Apple M4, macOS 26) | `self-hosted`, `macOS`, `ARM64`, `m3d-mac-vz` | The helper's tests and clippy, the runtime against the helper's compiled-in pins, the ten restriction tests on the real Virtualization framework, and the cable clip through both guests. |

Both jobs run on every push to `main`, every manual dispatch, and every same-repository pull request, so their check-runs are always present. The full work takes about 85 minutes, most of it two arm64 builds under qemu. A pull request that changes none of `cad-runtime/`, `cad-host/`, `scripts/release/`, `scripts/ci/cad-runtime-scope.sh`, or the workflow (decided against its merge base by `scripts/ci/cad-runtime-scope.sh`) skips the heavy steps, and both jobs pass in seconds. Pushes to `main` and manual dispatches always do the full work. When an app file starts compiling in or reading the runtime pins (PR 7's `cad_worker.rs`), add it to that script.

## Keeping fork pull requests off these machines

The repository is public, so a pull request from a fork could try to run code on these runners. A user-owned repository has no runner groups to limit which workflows may use a runner, and a fork's pull request runs the workflow files from its own head, so a fork can delete an `if:` or add its own self-hosted workflow. Three guards stand in the way:

1. **The fork approval policy.** No workflow run from a fork starts until a maintainer approves it. A maintainer approves a fork's run only after reading every change under `.github/`; agents never approve one. This is the guard that holds against a fork that edits the workflows.
2. **The same-repo condition.** Every self-hosted job runs only on a push to `main`, a manual dispatch, or a pull request whose head branch is in this repository:

   ```yaml
   if: >-
     github.actor != 'dependabot[bot]' && (
     github.event_name == 'push' || github.event_name == 'workflow_dispatch' ||
     (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
     && github.event.pull_request.user.login != 'dependabot[bot]'))
   ```

   An approved fork run that leaves the workflow alone still skips both jobs. The same `if:` also refuses Dependabot, both as the event's actor and as the pull request's author (`github.actor != 'dependabot[bot]'` and `github.event.pull_request.user.login != 'dependabot[bot]'`). The runners run as a host user whose `gh` login the runner guard reads, so code from a dependency update must not run there. A Dependabot pull request therefore never gets these two check-runs. For a bump under `cad-runtime/lock/`, a person takes the change onto their own branch, regenerates `pins-<arch>.json` with `cad-runtime/build.sh`, and opens that pull request, where both jobs run. A new self-hosted job must carry the same condition.
3. **The runner guard.** `scripts/ci/runner-guard.sh` runs on each runner host every 5 minutes. A policy other than `all_external_contributors` stops that host's runner at once. A read that fails (gh exits non-zero, or answers with nothing or with something that is not a policy name) is logged and retried 5 times, after 5, 10, 15, 20, and 25 seconds. Only when all 6 reads fail does the guard stop the runner. GitHub's API has brief outages: on 2026-10-03 two single failed reads, at 21:57 and 22:04 UTC, stopped dev-substrate's runner under the first version of the guard. It reads the policy with the host's own `gh` login for `AojdevStudio`. A job cannot run this check: `GITHUB_TOKEN` cannot read the policy (that takes administration read), and putting the owner's credential into a job would hand it to the job exactly when the policy has changed and a fork's job might be the one running. The guard never starts a runner. After it trips, read the policy, then restart the runner by hand (`sudo systemctl start <unit>` on dev-substrate, `launchctl bootstrap gui/$(id -u) <plist>` on the mini). Remaining limits:
   - A runner is unguarded for up to 5 minutes after the policy changes, about 6.5 minutes when that check's reads also fail, and for 30 seconds after dev-substrate boots.
   - A GitHub outage longer than the retries still stops the runner until a person restarts it.
   - A job runs as the same user as the guard and its `gh` login, so it could tamper with the guard while it runs. The guard keeps fork jobs from starting; it cannot contain one that already has.

The policy, read back on 2026-10-03:

```bash
gh api repos/AojdevStudio/materialize-3d/actions/permissions/fork-pr-contributor-approval
# {"approval_policy":"all_external_contributors"}
```

Read it again before trusting these notes; nothing in CI changes it. Same-repository pull requests from people with write access do run on these machines; Dependabot's do not.

## Host setup

### Linux: `dev-substrate`

- Runner 2.337.0 in `/home/ossie/actions-runner-materialize-3d`, as the user `ossie`, installed with the runner's own `svc.sh` as the systemd service `actions.runner.AojdevStudio-materialize-3d.dev-substrate-materialize-3d.service`. The tarball's sha256 matched the one in the release notes.
- `ossie` is in the `docker` group. Packages the job needs beyond Ubuntu's base: `docker.io`, `docker-buildx` (for `--platform` and the tar exporter), and `qemu-user-static`, which registers the arm64 binfmt handler at boot with the `F` flag so containers can run it.
- The job's first heavy step, `scripts/ci/check-image-host.sh`, fails with the missing piece named when Docker, buildx, the arm64 binfmt handler, or 20 GB of free disk is not there.
- The kernel tarball and its signature stay cached in `~/.cache/m3d-tool-cache/kernel/` between runs; every build checks the sha256 pin and the kernel.org signature again.
- The Python wheels stay cached in `~/.cache/m3d-tool-cache/wheels/<arch>/`, filled once per lock file before the image build (`.complete` holds the lock's sha256) and bind-mounted into it; pip checks every hash on download and again on install. A build after the first needs no PyPI access. This came from the first CI run on PR #23: dev-substrate lost its outbound connection for about two minutes while pip was fetching wheels inside the emulated build, pip's default retries ran out, and the quiet build hid pip's error. The image builds now also keep their full output in `cad-runtime/out/<arch>/*.log` and print its end on failure.
- Runner guard: the script is installed root-owned at `/usr/local/libexec/m3d-runner-guard` and runs as `ossie` from the systemd timer `m3d-runner-guard.timer` (30 seconds after boot, then every 5 minutes), which starts `m3d-runner-guard.service`:

  ```ini
  # /etc/systemd/system/m3d-runner-guard.service
  [Service]
  Type=oneshot
  User=ossie
  Environment=HOME=/home/ossie
  ExecStart=/usr/local/libexec/m3d-runner-guard linux actions.runner.AojdevStudio-materialize-3d.dev-substrate-materialize-3d.service
  # /etc/systemd/system/m3d-runner-guard.timer
  [Timer]
  OnBootSec=30s
  OnUnitActiveSec=5min
  [Install]
  WantedBy=timers.target
  ```

  Its log is `journalctl -u m3d-runner-guard.service`. It stops the runner with `sudo -n systemctl stop`, which needs `ossie`'s passwordless sudo. To update it, install the script from the repo over the old one (`sudo install -o root -g root -m 0755 scripts/ci/runner-guard.sh /usr/local/libexec/m3d-runner-guard`); the next timer run uses it.
- Docker's build cache is bounded by the daemon's garbage collector (`/etc/docker/daemon.json`, `defaultKeepStorage` 20 GB). The job builds with `--no-cache`, so each run adds fresh cache records for that collector to reclaim.

### Mac: the Mac mini

- Runner 2.337.0 in `~/actions-runners/materialize-3d-cad-macos-arm64/actions-runner`, as `aojdevstudio`, installed with `svc.sh` as the LaunchAgent `actions.runner.AojdevStudio-materialize-3d.mac-mini-m4-materialize-3d-cad` in the logged-in desktop session. A `README.md` beside it follows the layout of the mini's other runners.
- Its `PATH` (`.path`) is `/opt/homebrew/bin:~/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`: cargo from rustup, `jq`, `codesign`, and `shasum` come from there.
- The job signs the helper ad hoc with the virtualization entitlement. It holds no Developer ID material and no secrets; release signing happens only in `scripts/release/build-macos.sh`.
- The runner named `mac-mini-m4-materialize-3d` in `~/actions-runners/materialize-3d-macos-arm64/` belongs to the archived repository (`AojdevStudio/materialize-3d-archive`) and takes no jobs from this one.
- Runner guard: `runner-guard.sh` sits beside the runner's `README.md` and runs from the LaunchAgent `com.aojdevstudio.m3d-runner-guard` (`~/Library/LaunchAgents/com.aojdevstudio.m3d-runner-guard.plist`: `RunAtLoad`, `StartInterval` 300, `PATH` with `/opt/homebrew/bin`, arguments `macos <runner plist>`), logging to `~/Library/Logs/m3d-runner-guard.log`. The mini's active `gh` account is a different one, so the guard asks `gh auth token --user AojdevStudio` for the owner's token for its one call and never prints it. It stops the runner with `launchctl bootout`. To update it, copy the script from the repo over `runner-guard.sh`; the next run of the agent uses it.

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
