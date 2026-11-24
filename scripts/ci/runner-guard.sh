#!/usr/bin/env bash
# Keeps this host's self-hosted runner for AojdevStudio/materialize-3d off while fork pull requests could reach it:
#   scripts/ci/runner-guard.sh linux <systemd unit of the runner>
#   scripts/ci/runner-guard.sh macos <launchd plist of the runner>
#   scripts/ci/runner-guard.sh macos-daemon <launchd plist of a system LaunchDaemon runner>
#
# Reads the repository's fork approval policy with this host's own gh login for the repository owner. A policy
# other than all_external_contributors stops the runner service at once. A read that fails (gh exits non-zero, or
# prints anything but one of GitHub's documented values) is retried 5 times over about 75 seconds, because GitHub's
# API has brief outages; when every attempt fails the guard leaves the runner as it is and exits 0, so a network
# blip does not take the runner down. When the policy reads all_external_contributors and the runner is down, the
# guard starts it (sudo systemctl start on linux, launchctl bootstrap on macos / macos-daemon) and exits 0 only
# after it can confirm the service is up, or a distinct non-zero if the start cannot be confirmed. A confirmed
# wrong policy still exits 1 after a confirmed stop, or 3 when it cannot confirm the stop. A CI job cannot do this
# check itself: GITHUB_TOKEN cannot read the policy, and the owner's credential must never sit in a job, least of
# all on the day the policy has changed.
# Runs every 5 minutes: a systemd timer on dev-substrate, a system LaunchDaemon on the Mac mini (macos-daemon,
# since the mini's runner runs as a system LaunchDaemon under a CI user, homelab#1910).
set -uo pipefail
repo=AojdevStudio/materialize-3d
want=all_external_contributors
kind="${1:-}" target="${2:-}"
log() { printf '%s runner-guard: %s\n' "$(date -u +%FT%TZ)" "$*"; }
case "$kind" in
  linux | macos | macos-daemon) [[ -n "$target" ]] || { echo "usage: $0 linux <unit> | macos <plist> | macos-daemon <plist>" >&2; exit 2; } ;;
  *) echo "usage: $0 linux <unit> | macos <plist> | macos-daemon <plist>" >&2; exit 2 ;;
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

# On macos / macos-daemon, the launchd Label is read from the plist into $label. Returns 0 when that read works.
read_label() {
  if ! label="$(plutil -extract Label raw "$target" 2>&1)" || [[ -z "$label" ]]; then
    log "cannot read the Label from $target: ${label:0:200}"
    return 1
  fi
}

# Sets $state to up, down, or unknown. unknown means the start or stop must not be claimed.
runner_state() {
  state=unknown
  case "$kind" in
    linux)
      if systemctl is-active --quiet "$target"; then state=up; else state=down; fi
      ;;
    macos)
      domain="gui/$(id -u)"
      if ! read_label; then
        return
      elif ! launchctl print "$domain" >/dev/null 2>&1; then
        log "cannot read launchd domain $domain, so the runner state cannot be confirmed"
      elif launchctl print "$domain/$label" >/dev/null 2>&1; then
        state=up
      else
        state=down
      fi
      ;;
    macos-daemon)
      # Only launchctl's "Could not find service" (exit 113) counts as down, and a clean print as up. A failed
      # sudo or any other error proves nothing.
      if ! read_label; then
        return
      fi
      sudo -n launchctl print "system/$label" >/dev/null 2>&1
      rc=$?
      if (( rc == 0 )); then
        state=up
      elif (( rc == 113 )); then
        state=down
      else
        log "sudo launchctl print system/$label last exited $rc, not 0 or 113"
      fi
      ;;
  esac
}

# Stops the runner and confirms it is down. On macOS launchd knows the service by the plist's Label, which need
# not match the file name, so the Label is read from the plist; a service already gone needs no bootout.
# Sets $stopped to 1 only after the service is confirmed down.
stop_runner() {
  stopped=0
  case "$kind" in
    linux)
      if ! out="$(sudo -n systemctl stop "$target" 2>&1)"; then log "systemctl stop $target failed: ${out:0:200}"; fi
      if ! systemctl is-active --quiet "$target"; then stopped=1; fi
      ;;
    macos)
      domain="gui/$(id -u)"
      if ! read_label; then
        :
      elif ! launchctl print "$domain" >/dev/null 2>&1; then
        log "cannot read launchd domain $domain, so the stop cannot be confirmed"
      else
        if launchctl print "$domain/$label" >/dev/null 2>&1; then
          if ! out="$(launchctl bootout "$domain/$label" 2>&1)"; then
            log "launchctl bootout $domain/$label failed: ${out:0:200}"
          fi
        fi
        # bootout returns while launchd is still tearing the service down, so wait up to 30 seconds for it to go.
        for _ in $(seq 1 30); do
          if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
            stopped=1
            break
          fi
          sleep 1
        done
      fi
      ;;
    macos-daemon)
      # A system LaunchDaemon (runner as a dedicated CI user): bootout needs root, so it takes passwordless sudo.
      # Only launchctl's "Could not find service" (exit 113) counts as gone. A failed sudo or any other error
      # proves nothing, so it never reads as a stopped runner.
      if ! read_label; then
        :
      else
        # Boot out unless launchctl already says the service is gone: a failed first check proves nothing.
        sudo -n launchctl print "system/$label" >/dev/null 2>&1
        rc=$?
        if (( rc != 113 )); then
          if ! out="$(sudo -n launchctl bootout "system/$label" 2>&1)"; then
            log "sudo launchctl bootout system/$label failed: ${out:0:200}"
          fi
        fi
        for _ in $(seq 1 30); do
          sudo -n launchctl print "system/$label" >/dev/null 2>&1
          rc=$?
          if (( rc == 113 )); then
            stopped=1
            break
          fi
          sleep 1
        done
        (( stopped )) || log "sudo launchctl print system/$label last exited $rc, not 113 (service gone)"
      fi
      ;;
  esac
}

# Starts the runner and confirms it is up. Sets $started to 1 only after the service is confirmed up.
start_runner() {
  started=0
  case "$kind" in
    linux)
      if ! out="$(sudo -n systemctl start "$target" 2>&1)"; then log "systemctl start $target failed: ${out:0:200}"; fi
      for _ in $(seq 1 30); do
        if systemctl is-active --quiet "$target"; then
          started=1
          break
        fi
        sleep 1
      done
      ;;
    macos)
      domain="gui/$(id -u)"
      if ! read_label; then
        :
      elif ! launchctl print "$domain" >/dev/null 2>&1; then
        log "cannot read launchd domain $domain, so the start cannot be confirmed"
      else
        if ! out="$(launchctl bootstrap "$domain" "$target" 2>&1)"; then
          log "launchctl bootstrap $domain $target failed: ${out:0:200}"
        fi
        for _ in $(seq 1 30); do
          if launchctl print "$domain/$label" >/dev/null 2>&1; then
            started=1
            break
          fi
          sleep 1
        done
      fi
      ;;
    macos-daemon)
      # The documented start on the mini is `sudo launchctl bootstrap system <plist>`.
      if ! read_label; then
        :
      else
        if ! out="$(sudo -n launchctl bootstrap system "$target" 2>&1)"; then
          log "sudo launchctl bootstrap system $target failed: ${out:0:200}"
        fi
        for _ in $(seq 1 30); do
          sudo -n launchctl print "system/$label" >/dev/null 2>&1
          rc=$?
          if (( rc == 0 )); then
            started=1
            break
          fi
          sleep 1
        done
        (( started )) || log "sudo launchctl print system/$label last exited $rc, not 0 (service up)"
      fi
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
    break
  fi
  wait_s=$((attempt * 5))
  log "read $attempt of $attempts failed ($policy); retrying in ${wait_s}s"
  sleep "$wait_s"
done
if (( ! read_ok )); then
  log "read $attempts of $attempts failed ($policy); every read failed, leaving the runner as it is"
  exit 0
fi
if [[ "$policy" != "$want" ]]; then
  log "fork approval policy is $policy, not $want; stopping the runner"
  stop_runner
  if (( stopped )); then
    log "the runner is stopped; the guard will start it again once the policy reads $want"
    exit 1
  fi
  log "COULD NOT CONFIRM the runner is stopped ($target); stop it by hand"
  exit 3
fi

runner_state
if [[ "$state" == "up" ]]; then
  log "fork approval policy is $want; the runner stays up"
  exit 0
fi
if [[ "$state" != "down" ]]; then
  log "fork approval policy is $want, but the runner state for $target could not be confirmed; leave it as it is"
  exit 4
fi
log "fork approval policy is $want; starting the runner"
start_runner
if (( started )); then
  log "started $target"
  exit 0
fi
log "COULD NOT CONFIRM the runner is started ($target); start it by hand"
exit 4
