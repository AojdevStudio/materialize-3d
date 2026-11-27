#!/usr/bin/env bash
# Keeps this host's self-hosted runner for AojdevStudio/materialize-3d off while fork pull requests could reach it:
#   scripts/ci/runner-guard.sh linux <systemd unit of the runner>
#   scripts/ci/runner-guard.sh macos <launchd plist of the runner>
#   scripts/ci/runner-guard.sh macos-daemon <launchd plist of a system LaunchDaemon runner>
#
# Reads the repository's fork approval policy with this host's own gh login for the repository owner. A policy
# other than all_external_contributors stops the runner at once and disables it so a reboot does not bring it
# back. A read that fails (gh exits non-zero, or prints anything but one of GitHub's documented values) is retried
# 5 times over about 75 seconds, because GitHub's API has brief outages; when every attempt fails the guard leaves
# the runner as it is (it does not start, stop, enable, or disable it) and exits 5, so a network blip does not take
# the runner down and a confirmed stop stays in place, while the timer still records a failed check. When the
# policy reads all_external_contributors and the runner is not running, the guard enables it if a prior confirmed
# stop disabled it, starts it, and exits 0 only after it can confirm the runner process is running, or a distinct
# non-zero if the start cannot be confirmed. A confirmed wrong policy still exits 1 after a confirmed stop (process
# down and boot start disabled), or 3 when it cannot confirm that. A CI job cannot do this check itself:
# GITHUB_TOKEN cannot read the policy, and the owner's credential must never sit in a job, least of all on the day
# the policy has changed.
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

# True when the Linux unit is active and has a non-zero MainPID. is-active alone can be true for a unit
# whose process has already exited.
linux_is_running() {
  local pid
  systemctl is-active --quiet "$target" || return 1
  pid="$(systemctl show -p MainPID --value "$target" 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]]
}

# Classifies a launchctl print of a service from $print_rc and $print_out: up (loaded and a live pid),
# loaded (registered but not running), down (exit 113), or unknown (any other error).
macos_state_from_print() {
  # Use only the service-level state and pid (the shallowest of those keys). A nested
  # coalition can print "state = active" after "state = running"; that must not win.
  local pid="" st="" line raw indent min_indent=""
  if (( print_rc == 113 )); then
    state=down
    return
  fi
  if (( print_rc != 0 )); then
    state=unknown
    return
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    raw="$line"
    line="${line#"${line%%[![:space:]]*}"}"
    indent=$(( ${#raw} - ${#line} ))
    case "$line" in
      "pid = "*|"state = "*)
        if [[ -z "$min_indent" || "$indent" -lt "$min_indent" ]]; then
          min_indent=$indent
          pid=""
          st=""
        fi
        if (( indent == min_indent )); then
          case "$line" in
            "pid = "*) pid="${line#pid = }" ;;
            "state = "*) st="${line#state = }" ;;
          esac
        fi
        ;;
    esac
  done <<< "$print_out"
  if [[ "$st" == "running" && "$pid" =~ ^[1-9][0-9]*$ ]]; then
    state=up
  else
    state=loaded
  fi
}

# Sets $state to up, loaded, down, or unknown. up means the runner process is running. loaded means
# launchd still has the job but the process is not running (do not bootstrap again). unknown means a
# start or stop must not be claimed.
runner_state() {
  state=unknown
  case "$kind" in
    linux)
      if linux_is_running; then state=up; else state=down; fi
      ;;
    macos)
      domain="gui/$(id -u)"
      if ! read_label; then
        return
      elif ! launchctl print "$domain" >/dev/null 2>&1; then
        log "cannot read launchd domain $domain, so the runner state cannot be confirmed"
      else
        print_out="$(launchctl print "$domain/$label" 2>&1)"
        print_rc=$?
        macos_state_from_print
      fi
      ;;
    macos-daemon)
      # Only launchctl's "Could not find service" (exit 113) counts as down. A failed sudo or any other
      # error proves nothing. A successful print is up only when the process is running.
      if ! read_label; then
        return
      fi
      print_out="$(sudo -n launchctl print "system/$label" 2>&1)"
      print_rc=$?
      if (( print_rc != 0 && print_rc != 113 )); then
        log "sudo launchctl print system/$label last exited $print_rc, not 0 or 113"
      fi
      macos_state_from_print
      ;;
  esac
}

# Disables boot start and stops the runner. Sets $stopped to 1 only after the process is down and boot
# start is disabled, so a reboot cannot bring the runner back before the next allowed-policy read.
stop_runner() {
  stopped=0
  case "$kind" in
    linux)
      if ! out="$(sudo -n systemctl disable --now "$target" 2>&1)"; then
        log "systemctl disable --now $target failed: ${out:0:200}"
      fi
      if linux_is_running; then
        return
      fi
      # A nonzero is-enabled exit is not proof of disablement (the probe itself can fail).
      # Only the printed word "disabled" confirms the stop would survive a reboot.
      enabled_state="$(systemctl is-enabled "$target" 2>/dev/null || true)"
      if [[ "$enabled_state" != "disabled" ]]; then
        log "systemctl is-enabled $target is ${enabled_state:-unknown}; the stop would not survive a reboot"
        return
      fi
      stopped=1
      ;;
    macos)
      domain="gui/$(id -u)"
      if ! read_label; then
        :
      elif ! launchctl print "$domain" >/dev/null 2>&1; then
        log "cannot read launchd domain $domain, so the stop cannot be confirmed"
      else
        if ! out="$(launchctl disable "$domain/$label" 2>&1)"; then
          log "launchctl disable $domain/$label failed: ${out:0:200}"
          return
        fi
        print_out="$(launchctl print "$domain/$label" 2>&1)"
        print_rc=$?
        if (( print_rc != 113 )); then
          if ! out="$(launchctl bootout "$domain/$label" 2>&1)"; then
            log "launchctl bootout $domain/$label failed: ${out:0:200}"
          fi
        fi
        # bootout returns while launchd is still tearing the service down, so wait up to 30 seconds for it to go.
        for _ in $(seq 1 30); do
          print_out="$(launchctl print "$domain/$label" 2>&1)"
          print_rc=$?
          macos_state_from_print
          if [[ "$state" == "down" ]]; then
            stopped=1
            break
          fi
          sleep 1
        done
      fi
      ;;
    macos-daemon)
      # disable and bootout need root, so they take passwordless sudo. Only launchctl's "Could not find
      # service" (exit 113) counts as gone. A failed sudo or a failed disable proves nothing, so it
      # never reads as a confirmed stop that would survive a reboot.
      if ! read_label; then
        :
      else
        if ! out="$(sudo -n launchctl disable "system/$label" 2>&1)"; then
          log "sudo launchctl disable system/$label failed: ${out:0:200}"
          return
        fi
        sudo -n launchctl print "system/$label" >/dev/null 2>&1
        rc=$?
        if (( rc != 113 )); then
          if ! out="$(sudo -n launchctl bootout "system/$label" 2>&1)"; then
            log "sudo launchctl bootout system/$label failed: ${out:0:200}"
          fi
        fi
        for _ in $(seq 1 30); do
          print_out="$(sudo -n launchctl print "system/$label" 2>&1)"
          print_rc=$?
          macos_state_from_print
          if [[ "$state" == "down" ]]; then
            stopped=1
            break
          fi
          sleep 1
        done
        (( stopped )) || log "sudo launchctl print system/$label last exited $print_rc, not 113 (service gone)"
      fi
      ;;
  esac
}

# Enables boot start if a confirmed stop had disabled it, starts the runner, and confirms the process
# is running. A job that is loaded but not running is kicked, not bootstrapped again. Sets $started to
# 1 only after the runner process is confirmed running.
start_runner() {
  started=0
  case "$kind" in
    linux)
      if ! out="$(sudo -n systemctl enable --now "$target" 2>&1)"; then
        log "systemctl enable --now $target failed: ${out:0:200}"
      fi
      for _ in $(seq 1 30); do
        if linux_is_running; then
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
        if ! out="$(launchctl enable "$domain/$label" 2>&1)"; then
          log "launchctl enable $domain/$label failed: ${out:0:200}"
        fi
        runner_state
        if [[ "$state" == "loaded" ]]; then
          if ! out="$(launchctl kickstart "$domain/$label" 2>&1)"; then
            log "launchctl kickstart $domain/$label failed: ${out:0:200}"
          fi
        elif [[ "$state" != "up" ]]; then
          if ! out="$(launchctl bootstrap "$domain" "$target" 2>&1)"; then
            log "launchctl bootstrap $domain $target failed: ${out:0:200}"
          fi
        fi
        for _ in $(seq 1 30); do
          runner_state
          if [[ "$state" == "up" ]]; then
            started=1
            break
          fi
          sleep 1
        done
      fi
      ;;
    macos-daemon)
      # Enable first so a prior confirmed stop does not block bootstrap. A loaded-but-dead job is
      # kicked; a missing job is bootstrapped from the plist, as the mini's runbook describes.
      if ! read_label; then
        :
      else
        if ! out="$(sudo -n launchctl enable "system/$label" 2>&1)"; then
          log "sudo launchctl enable system/$label failed: ${out:0:200}"
        fi
        runner_state
        if [[ "$state" == "loaded" ]]; then
          if ! out="$(sudo -n launchctl kickstart "system/$label" 2>&1)"; then
            log "sudo launchctl kickstart system/$label failed: ${out:0:200}"
          fi
        elif [[ "$state" != "up" ]]; then
          if ! out="$(sudo -n launchctl bootstrap system "$target" 2>&1)"; then
            log "sudo launchctl bootstrap system $target failed: ${out:0:200}"
          fi
        fi
        for _ in $(seq 1 30); do
          runner_state
          if [[ "$state" == "up" ]]; then
            started=1
            break
          fi
          sleep 1
        done
        (( started )) || log "the runner process for $target was not running after start"
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
  exit 5
fi
if [[ "$policy" != "$want" ]]; then
  log "fork approval policy is $policy, not $want; stopping the runner"
  stop_runner
  if (( stopped )); then
    log "the runner is stopped and disabled; the guard will start it again once the policy reads $want"
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
if [[ "$state" == "unknown" ]]; then
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
