#!/usr/bin/env bash
# Keeps this host's self-hosted runner for AojdevStudio/materialize-3d off while fork pull requests could reach it:
#   scripts/ci/runner-guard.sh linux <systemd unit of the runner>
#   scripts/ci/runner-guard.sh macos <launchd plist of the runner>
#
# Reads the repository's fork approval policy with this host's own gh login for the repository owner. A policy
# other than all_external_contributors stops the runner service at once. A read that fails (gh exits non-zero, or
# prints anything but one of GitHub's documented values) is retried 5 times over about 75 seconds, because GitHub's
# API has brief outages; only when every attempt fails does the guard stop the runner. Either way it then exits 1,
# so the timer that runs it records a failure. It never starts a runner: after it trips, a person reads the policy
# and restarts the service (docs/ci-runners.md). A CI job cannot do this check itself: GITHUB_TOKEN cannot read the
# policy, and the owner's credential must never sit in a job, least of all on the day the policy has changed.
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

# One read of the policy into $policy. Returns 0 when gh answered with one of the values GitHub documents for
# approval_policy (REST "Get fork PR contributor approval permissions": first_time_contributors_new_to_github,
# first_time_contributors, all_external_contributors), and 1 for anything else, with the reason in $policy: a gh
# failure, no answer, or any other text, an unknown word included, counts as a failed read. The owner's token
# comes from gh's own store for this one call and is never printed or written anywhere.
read_policy() {
  local token out rc=0
  if ! token="$(gh auth token --user "${repo%%/*}" 2>/dev/null)" || [[ -z "$token" ]]; then
    policy="no gh login for ${repo%%/*} on this host"
    return 1
  fi
  out="$(GH_TOKEN="$token" gh api "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
    --jq .approval_policy 2>&1)" || rc=$?
  unset token
  if (( rc != 0 )); then
    policy="gh exit $rc: ${out:0:200}"
    return 1
  fi
  case "$out" in
    first_time_contributors_new_to_github | first_time_contributors | all_external_contributors)
      policy="$out"
      ;;
    *)
      policy="unreadable answer: ${out:0:200}"
      return 1
      ;;
  esac
}

# The first read plus 5 retries, waiting 5, 10, 15, 20, and 25 seconds between them.
policy="" read_ok=0 attempts=6
for attempt in $(seq 1 "$attempts"); do
  if read_policy; then
    read_ok=1
    break
  fi
  if (( attempt == attempts )); then
    log "read $attempt of $attempts failed ($policy); every read failed, stopping the runner"
    break
  fi
  wait_s=$((attempt * 5))
  log "read $attempt of $attempts failed ($policy); retrying in ${wait_s}s"
  sleep "$wait_s"
done
if (( read_ok )) && [[ "$policy" == "$want" ]]; then
  log "fork approval policy is $want; the runner stays up"
  exit 0
fi
if (( read_ok )); then
  log "fork approval policy is $policy, not $want; stopping the runner"
fi

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
