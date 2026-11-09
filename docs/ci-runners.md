# Self-hosted CI runners

Every job in this repository runs on a machine Ossie owns. No workflow selects a GitHub-hosted runner.

| Job (check-run name) | Runner | Host | Labels |
|---|---|---|---|
| `Linux build and checks` | `dev-substrate-materialize-3d` | `dev-substrate`, an x86_64 Ubuntu 24.04 VM (8 vCPUs) | `self-hosted`, `Linux`, `X64`, `m3d-linux-kvm` |
| `macOS desktop build gate` | `mac-mini-m4-materialize-3d-cad` | the Mac mini (Apple M4, macOS 26) | `self-hosted`, `macOS`, `ARM64`, `m3d-mac-vz` |
| `Landing site` | `mac-mini-m4-materialize-3d-cad` | the Mac mini | `self-hosted`, `macOS`, `ARM64`, `m3d-mac-vz` |
| `TLA+ models match the code`, `PR body contract`, and Pullfrog | `dev-substrate-materialize-3d` | `dev-substrate` | `self-hosted`, `Linux`, `X64`, `m3d-linux-kvm` |
| `Merge danger` | a homelab runner | homelab | `self-hosted`, `Linux`, `homelab-ci` |

The site job runs on the Mac mini because its tests launch the installed Google Chrome, which the Mac mini has and the Linux runner does not. The runner names and the `m3d-linux-kvm` and `m3d-mac-vz` labels date from the CAD runtime jobs, which are gone. They stay so that no runner has to be registered again.

## Keeping fork pull requests off these machines

The repository is public, so a pull request from a fork could try to run code on these runners. A user-owned repository has no runner groups to limit which workflows may use a runner, and a fork's pull request runs the workflow files from its own head, so a fork can delete an `if:` or add its own self-hosted workflow. Three guards stand in the way:

1. **The fork approval policy.** No workflow run from a fork starts until a maintainer approves it. A maintainer approves a fork's run only after reading every change under `.github/`; agents never approve one. This is the guard that holds against a fork that edits the workflows.
2. **The same-repo condition.** Build jobs run only on a push to `main`, a manual dispatch where supported, or a pull request whose head branch is in this repository. The PR body job uses `pull_request_target`, checks only the base SHA, and admits only same-repository, non-Dependabot pull requests. Pullfrog's app can dispatch fork PR reviews on the default branch, so `workflow_dispatch` alone is not a trust check. Before checkout or the Pullfrog action, `actions/github-script@v8` parses the prompt from an environment variable. It requires a JSON envelope with `~pullfrog: true`, `event.is_pr: true`, a safe positive integer `event.issue_number`, and `event.authorPermission` of `admin`, `maintain`, or `write`. It rejects Dependabot as either the dispatch actor or the original triggerer. It then reads the actual PR through GitHub's API and requires a head in this repository and an author other than `dependabot[bot]`. A malformed or unsupported prompt or a failed API call fails the job before checkout. Provider credentials remain scoped to the Pullfrog action step. The build condition is:

   ```yaml
   if: >-
     github.actor != 'dependabot[bot]' && (
     github.event_name == 'push' ||
     (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
     && github.event.pull_request.user.login != 'dependabot[bot]'))
   ```

   An approved fork run that leaves the workflow alone still skips every self-hosted job. The same `if:` also refuses Dependabot, both as the event's actor and as the pull request's author (`github.actor != 'dependabot[bot]'` and `github.event.pull_request.user.login != 'dependabot[bot]'`). The runners run as a host user whose `gh` login the runner guard reads, so code from a dependency update must not run there. A Dependabot pull request therefore never gets these check-runs. A person takes such a change onto their own branch and opens that pull request, where they all run. A new self-hosted job must carry the same condition.
3. **The runner guard.** `scripts/ci/runner-guard.sh` runs on each runner host every 5 minutes. A policy other than `all_external_contributors` stops that host's runner at once. A read that fails (gh exits non-zero, or answers with anything other than one of the three values GitHub documents for this setting: `first_time_contributors_new_to_github`, `first_time_contributors`, `all_external_contributors`) is logged and retried 5 times, after 5, 10, 15, 20, and 25 seconds. Only when all 6 reads fail does the guard stop the runner. GitHub's API has brief outages: on 2026-10-03 two single failed reads, at 21:57 and 22:04 UTC, stopped dev-substrate's runner under the first version of the guard. It reads the policy with the host's own `gh` login for `AojdevStudio`. A job cannot run this check: `GITHUB_TOKEN` cannot read the policy (that takes administration read), and putting the owner's credential into a job would hand it to the job exactly when the policy has changed and a fork's job might be the one running. The guard never starts a runner. After it trips, read the policy, then restart the runner by hand (`sudo systemctl start <unit>` on dev-substrate, `launchctl bootstrap gui/$(id -u) <plist>` on the mini). Remaining limits:
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
- Bambu Studio for the slice test installs into the runner's tool cache with `scripts/ci/install-bambu-linux.sh`.
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

### Mac: the Mac mini

- Runner 2.337.0 in `~/actions-runners/materialize-3d-cad-macos-arm64/actions-runner`, as `aojdevstudio`, installed with `svc.sh` as the LaunchAgent `actions.runner.AojdevStudio-materialize-3d.mac-mini-m4-materialize-3d-cad` in the logged-in desktop session. A `README.md` beside it follows the layout of the mini's other runners.
- Its `PATH` (`.path`) is `/opt/homebrew/bin:~/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`: cargo from rustup, `jq`, `codesign`, and `shasum` come from there.
- The jobs hold no Developer ID material and no release secrets. Release signing happens only in `scripts/release/build-macos.sh`. `actions/checkout` keeps the job's `GITHUB_TOKEN` in the checkout's Git config until its post-job cleanup, so code a job runs can read that token while the job runs.
- The runner named `mac-mini-m4-materialize-3d` in `~/actions-runners/materialize-3d-macos-arm64/` belongs to the archived repository (`AojdevStudio/materialize-3d-archive`) and takes no jobs from this one.
- Runner guard: `runner-guard.sh` sits beside the runner's `README.md` and runs from the LaunchAgent `com.aojdevstudio.m3d-runner-guard` (`~/Library/LaunchAgents/com.aojdevstudio.m3d-runner-guard.plist`: `RunAtLoad`, `StartInterval` 300, `PATH` with `/opt/homebrew/bin`, arguments `macos <runner plist>`), logging to `~/Library/Logs/m3d-runner-guard.log`. The mini's active `gh` account is a different one, so the guard asks `gh auth token --user AojdevStudio` for the owner's token for its one call and never prints it. It reads the runner's launchd Label from the plist (`plutil -extract Label raw`; for this runner the Label matches the file name), stops the service with `launchctl bootout gui/<uid>/<Label>`, and waits up to 30 seconds for `launchctl print` to report the service gone. `bootout` returns before launchd has finished tearing the service down. When the stop cannot be confirmed, the guard says so and exits 3. To update it, copy the script from the repo over `runner-guard.sh`; the next run of the agent uses it.

### Registering a runner again

Registration needs a short-lived token. Pass it through the environment so it stays out of `argv` and the shell history:

```bash
gh api -X POST repos/AojdevStudio/materialize-3d/actions/runners/registration-token --jq .token \
  | ssh <host> 'IFS= read -r t; cd <runner dir> && ACTIONS_RUNNER_INPUT_TOKEN="$t" ./config.sh --unattended \
      --url https://github.com/AojdevStudio/materialize-3d --name <name> --labels <label> --work _work'
```

Then install the service (`sudo ./svc.sh install ossie && sudo ./svc.sh start` on Linux, `./svc.sh install && ./svc.sh start` on the Mac) and check `gh api repos/AojdevStudio/materialize-3d/actions/runners`.
