#!/usr/bin/env bash
# Keeps this host's self-hosted runner for AojdevStudio/materialize-3d off while fork pull requests could reach it:
#   scripts/ci/runner-guard.sh linux <systemd unit of the runner>
#   scripts/ci/runner-guard.sh macos <launchd plist of the runner>
#
# Reads the repository's fork approval policy with this host's own gh login for the repository owner. Unless the
# read succeeds and says all_external_contributors, it stops the runner service and exits 1, so the timer that runs
# it records a failure. It never starts a runner: after it trips, a person reads the policy and restarts the
# service (docs/ci-runners.md). A CI job cannot do this check itself: GITHUB_TOKEN cannot read the policy, and the
# owner's credential must never sit in a job, least of all on the day the policy has changed.
# Runs every 5 minutes: a systemd timer on dev-substrate, a LaunchAgent on the Mac mini.
set -uo pipefail
repo=AojdevStudio/materialize-3d
want=all_external_contributors
kind="${1:-}" target="${2:-}"
log() { printf '%s runner-guard: %s\n' "$(date -u +%FT%TZ)" "$*"; }
case "$kind" in
  linux | macos) [[ -n "$target" ]] || { echo "usage: $0 linux <unit> | macos <plist>" >&2; exit 2; } ;;
  *) echo "usage: $0 linux <unit> | macos <plist>" >&2; exit 2 ;;
esac

# The repository owner's token, from gh's own store, for this one call; it is never printed or written anywhere.
policy="" rc=0
if token="$(gh auth token --user "${repo%%/*}" 2>/dev/null)" && [[ -n "$token" ]]; then
  policy="$(GH_TOKEN="$token" gh api "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
    --jq .approval_policy 2>&1)" || rc=$?
else
  rc=$? policy="no gh login for ${repo%%/*} on this host"
fi
unset token
if (( rc == 0 )) && [[ "$policy" == "$want" ]]; then
  log "fork approval policy is $want; the runner stays up"
  exit 0
fi
log "fork approval policy is not $want (gh exit $rc: ${policy:0:200}); stopping the runner"

stopped=0
case "$kind" in
  linux)
    sudo -n systemctl stop "$target" || log "systemctl stop $target failed"
    if ! systemctl is-active --quiet "$target"; then stopped=1; fi
    ;;
  macos)
    label="$(basename "$target" .plist)"
    launchctl bootout "gui/$(id -u)" "$target" 2>/dev/null || true   # fails when it is already unloaded
    if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then stopped=1; fi
    ;;
esac
if (( stopped )); then
  log "the runner is stopped; restart it by hand once the policy reads $want again"
else
  log "COULD NOT STOP the runner ($target)"
fi
exit 1
