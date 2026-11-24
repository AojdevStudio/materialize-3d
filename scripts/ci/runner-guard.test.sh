#!/usr/bin/env bash
# Exercises scripts/ci/runner-guard.sh with stub commands on PATH. It never talks to GitHub, systemd, or launchd.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
guard="$root/scripts/ci/runner-guard.sh"
fail=0
ran=0

assert_eq() {
  local name="$1" got="$2" want="$3"
  ran=$((ran + 1))
  if [[ "$got" == "$want" ]]; then
    printf 'ok %s\n' "$name"
  else
    printf 'FAIL %s: got %q, want %q\n' "$name" "$got" "$want"
    fail=1
  fi
}

assert_contains() {
  local name="$1" got="$2" needle="$3"
  ran=$((ran + 1))
  if [[ "$got" == *"$needle"* ]]; then
    printf 'ok %s\n' "$name"
  else
    printf 'FAIL %s: expected to find %q in %q\n' "$name" "$needle" "$got"
    fail=1
  fi
}

assert_not_contains() {
  local name="$1" got="$2" needle="$3"
  ran=$((ran + 1))
  if [[ "$got" != *"$needle"* ]]; then
    printf 'ok %s\n' "$name"
  else
    printf 'FAIL %s: did not expect %q in %q\n' "$name" "$needle" "$got"
    fail=1
  fi
}

write_stubs() {
  local work="$1"
  mkdir -p "$work/bin"
  printf 'enabled\n' > "$work/enabled"
  printf '0\n' > "$work/main_pid"
  cat > "$work/bin/gh" << 'SH'
#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  if [ "${GH_STUB_AUTH:-ok}" = "fail" ]; then exit 1; fi
  printf 'test-token-not-a-secret\n'
  exit 0
fi
if [ "$1" = "api" ]; then
  if [ "${GH_STUB_API:-ok}" = "fail" ]; then
    printf 'HTTP 502\n' >&2
    exit 1
  fi
  printf '%s\n' "${GH_STUB_POLICY:-all_external_contributors}"
  exit 0
fi
exit 99
SH
  cat > "$work/bin/sudo" << 'SH'
#!/bin/sh
if [ "$1" = "-n" ]; then shift; fi
printf 'sudo %s\n' "$*" >> "$STUB_WORK/cmds"
exec "$@"
SH
  cat > "$work/bin/systemctl" << 'SH'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$STUB_WORK/cmds"
# systemctl disable --now UNIT / enable --now UNIT / show -p MainPID --value UNIT
if [ "$1" = "is-active" ]; then
  [ "$2" = "--quiet" ] && shift
  shift
  [ "$(cat "$STUB_WORK/unit_state")" = "active" ] && exit 0
  exit 3
fi
if [ "$1" = "is-enabled" ]; then
  [ "$2" = "--quiet" ] && shift
  shift
  state="$(cat "$STUB_WORK/enabled")"
  if [ "$state" = "error" ]; then
    printf 'Failed to get unit file state\n' >&2
    exit 1
  fi
  printf '%s\n' "$state"
  [ "$state" = "enabled" ] && exit 0
  exit 1
fi
if [ "$1" = "show" ]; then
  # show -p MainPID --value UNIT
  if [ "$(cat "$STUB_WORK/unit_state")" = "active" ]; then
    cat "$STUB_WORK/main_pid"
    echo
    exit 0
  fi
  printf '0\n'
  exit 0
fi
if [ "$1" = "stop" ]; then
  printf 'inactive\n' > "$STUB_WORK/unit_state"
  printf '0\n' > "$STUB_WORK/main_pid"
  exit 0
fi
if [ "$1" = "start" ]; then
  if [ "${SYSTEMCTL_STUB_START:-ok}" = "fail" ]; then exit 1; fi
  printf 'active\n' > "$STUB_WORK/unit_state"
  if [ "${SYSTEMCTL_STUB_PID:-ok}" = "zero" ]; then
    printf '0\n' > "$STUB_WORK/main_pid"
  else
    printf '4242\n' > "$STUB_WORK/main_pid"
  fi
  exit 0
fi
if [ "$1" = "disable" ]; then
  if [ "${SYSTEMCTL_STUB_DISABLE:-ok}" = "fail" ]; then exit 1; fi
  printf 'disabled\n' > "$STUB_WORK/enabled"
  if [ "$2" = "--now" ]; then
    printf 'inactive\n' > "$STUB_WORK/unit_state"
    printf '0\n' > "$STUB_WORK/main_pid"
  fi
  exit 0
fi
if [ "$1" = "enable" ]; then
  if [ "${SYSTEMCTL_STUB_ENABLE:-ok}" = "fail" ]; then exit 1; fi
  printf 'enabled\n' > "$STUB_WORK/enabled"
  if [ "$2" = "--now" ]; then
    if [ "${SYSTEMCTL_STUB_START:-ok}" = "fail" ]; then exit 1; fi
    printf 'active\n' > "$STUB_WORK/unit_state"
    if [ "${SYSTEMCTL_STUB_PID:-ok}" = "zero" ]; then
      printf '0\n' > "$STUB_WORK/main_pid"
    else
      printf '4242\n' > "$STUB_WORK/main_pid"
    fi
  fi
  exit 0
fi
exit 99
SH
  cat > "$work/bin/sleep" << 'SH'
#!/bin/sh
exit 0
SH
  cat > "$work/bin/plutil" << 'SH'
#!/bin/sh
if [ "$1" = "-extract" ] && [ "$2" = "Label" ] && [ "$3" = "raw" ]; then
  cat "$STUB_WORK/label"
  exit 0
fi
exit 99
SH
  cat > "$work/bin/launchctl" << 'SH'
#!/bin/sh
printf 'launchctl %s\n' "$*" >> "$STUB_WORK/cmds"
# print gui/<uid> is a domain probe; print gui/<uid>/<label> or system/<label> is the service.
if [ "$1" = "print" ]; then
  case "$2" in
    system/*|gui/*/*)
      case "$(cat "$STUB_WORK/unit_state")" in
        running)
          # Nested coalition state/pid come after the service-level fields, as on macOS 26.
          printf '%s\n' "com.example.runner = {"             "	state = running"             "	pid = 4242"             "	jetsam coalition = {"             "		state = active"             "		pid = 0"             "	}"             "}"
          exit 0
          ;;
        loaded)
          printf '\tstate = exited\n\tpid = 0\n'
          exit 0
          ;;
        *)
          exit 113
          ;;
      esac
      ;;
    gui/*)
      exit 0
      ;;
  esac
  exit 99
fi
if [ "$1" = "disable" ]; then
  printf 'disabled\n' > "$STUB_WORK/enabled"
  exit 0
fi
if [ "$1" = "enable" ]; then
  printf 'enabled\n' > "$STUB_WORK/enabled"
  exit 0
fi
if [ "$1" = "bootout" ]; then
  printf 'unloaded\n' > "$STUB_WORK/unit_state"
  exit 0
fi
if [ "$1" = "bootstrap" ]; then
  if [ "${LAUNCHCTL_STUB_BOOTSTRAP:-ok}" = "fail" ]; then exit 1; fi
  if [ "${LAUNCHCTL_STUB_BOOTSTRAP:-ok}" = "loaded-only" ]; then
    printf 'loaded\n' > "$STUB_WORK/unit_state"
    exit 0
  fi
  printf 'running\n' > "$STUB_WORK/unit_state"
  exit 0
fi
if [ "$1" = "kickstart" ]; then
  if [ "${LAUNCHCTL_STUB_KICKSTART:-ok}" = "fail" ]; then exit 1; fi
  printf 'running\n' > "$STUB_WORK/unit_state"
  exit 0
fi
exit 99
SH
  chmod +x "$work/bin"/*
}

run_guard() {
  local work="$1" kind="$2" target="$3"
  shift 3
  STUB_WORK="$work" PATH="$work/bin:$PATH" \
    env -u GH_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_TOKEN "$@" \
    "$guard" "$kind" "$target" >"$work/out" 2>"$work/err" && true
  rc=$?
}

cmds() { cat "$1/cmds" 2>/dev/null || true; }
out() { cat "$1/out"; }

# --- linux ---

work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
printf '4242\n' > "$work/main_pid"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_API=fail
assert_eq "linux all reads fail: exit 5" "$rc" "5"
assert_contains "linux all reads fail: left alone" "$(out "$work")" "every read failed, leaving the runner as it is"
assert_not_contains "linux all reads fail: no stop" "$(cmds "$work")" "systemctl stop"
assert_not_contains "linux all reads fail: no disable" "$(cmds "$work")" "systemctl disable"
assert_not_contains "linux all reads fail: no start" "$(cmds "$work")" "systemctl start"
assert_not_contains "linux all reads fail: no enable" "$(cmds "$work")" "systemctl enable"
assert_eq "linux all reads fail: still active" "$(cat "$work/unit_state")" "active"
assert_eq "linux all reads fail: still enabled" "$(cat "$work/enabled")" "enabled"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
printf '4242\n' > "$work/main_pid"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_AUTH=fail
assert_eq "linux auth fail: exit 5" "$rc" "5"
assert_not_contains "linux auth fail: no disable" "$(cmds "$work")" "systemctl disable"
assert_eq "linux auth fail: still active" "$(cat "$work/unit_state")" "active"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
printf '4242\n' > "$work/main_pid"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=first_time_contributors
assert_eq "linux wrong policy: exit 1" "$rc" "1"
assert_contains "linux wrong policy: stopping" "$(out "$work")" "stopping the runner"
assert_contains "linux wrong policy: disable --now" "$(cmds "$work")" "systemctl disable --now fake.unit"
assert_not_contains "linux wrong policy: no start" "$(cmds "$work")" "systemctl start"
assert_not_contains "linux wrong policy: no enable" "$(cmds "$work")" "systemctl enable"
assert_eq "linux wrong policy: now inactive" "$(cat "$work/unit_state")" "inactive"
assert_eq "linux wrong policy: now disabled" "$(cat "$work/enabled")" "disabled"
rm -rf "$work"

# disable --now can fail while the unit is already down; an is-enabled probe error is not disablement.
work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
printf '0\n' > "$work/main_pid"
printf 'error\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=first_time_contributors SYSTEMCTL_STUB_DISABLE=fail
assert_eq "linux disable unknown: exit 3" "$rc" "3"
assert_contains "linux disable unknown: not confirmed" "$(out "$work")" "COULD NOT CONFIRM the runner is stopped"
assert_not_contains "linux disable unknown: not claimed disabled" "$(out "$work")" "stopped and disabled"
assert_eq "linux disable unknown: still inactive" "$(cat "$work/unit_state")" "inactive"
assert_eq "linux disable unknown: enablement still error" "$(cat "$work/enabled")" "error"
rm -rf "$work"

# An already-inactive unit whose is-enabled output is disabled is a confirmed stop even if disable --now fails.
work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
printf '0\n' > "$work/main_pid"
printf 'disabled\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=first_time_contributors SYSTEMCTL_STUB_DISABLE=fail
assert_eq "linux already disabled: exit 1" "$rc" "1"
assert_contains "linux already disabled: claimed" "$(out "$work")" "stopped and disabled"
rm -rf "$work"

# A confirmed stop must stay down when later reads fail (the reboot case after disable).
work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
printf '0\n' > "$work/main_pid"
printf 'disabled\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_API=fail
assert_eq "linux confirmed-stop + failed read: exit 5" "$rc" "5"
assert_not_contains "linux confirmed-stop + failed read: no enable" "$(cmds "$work")" "systemctl enable"
assert_not_contains "linux confirmed-stop + failed read: no start" "$(cmds "$work")" "systemctl start"
assert_eq "linux confirmed-stop + failed read: still inactive" "$(cat "$work/unit_state")" "inactive"
assert_eq "linux confirmed-stop + failed read: still disabled" "$(cat "$work/enabled")" "disabled"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
printf '0\n' > "$work/main_pid"
printf 'disabled\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=all_external_contributors
assert_eq "linux want + down: exit 0" "$rc" "0"
assert_contains "linux want + down: starting" "$(out "$work")" "starting the runner"
assert_contains "linux want + down: started" "$(out "$work")" "started fake.unit"
assert_contains "linux want + down: enable --now" "$(cmds "$work")" "systemctl enable --now fake.unit"
assert_not_contains "linux want + down: no disable" "$(cmds "$work")" "systemctl disable"
assert_eq "linux want + down: now active" "$(cat "$work/unit_state")" "active"
assert_eq "linux want + down: now enabled" "$(cat "$work/enabled")" "enabled"
assert_eq "linux want + down: has pid" "$(cat "$work/main_pid")" "4242"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
printf '4242\n' > "$work/main_pid"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=all_external_contributors
assert_eq "linux want + up: exit 0" "$rc" "0"
assert_contains "linux want + up: stays up" "$(out "$work")" "the runner stays up"
assert_not_contains "linux want + up: no start" "$(cmds "$work")" "systemctl start"
assert_not_contains "linux want + up: no enable" "$(cmds "$work")" "systemctl enable"
assert_not_contains "linux want + up: no disable" "$(cmds "$work")" "systemctl disable"
assert_eq "linux want + up: still active" "$(cat "$work/unit_state")" "active"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
printf '0\n' > "$work/main_pid"
printf 'disabled\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=all_external_contributors SYSTEMCTL_STUB_START=fail
assert_eq "linux start fails: exit 4" "$rc" "4"
assert_contains "linux start fails: could not confirm" "$(out "$work")" "COULD NOT CONFIRM the runner is started"
assert_eq "linux start fails: still inactive" "$(cat "$work/unit_state")" "inactive"
rm -rf "$work"

# is-active can succeed with MainPID 0; that must not be reported as a started runner.
work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
printf '0\n' > "$work/main_pid"
printf 'disabled\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=all_external_contributors SYSTEMCTL_STUB_PID=zero
assert_eq "linux start with pid 0: exit 4" "$rc" "4"
assert_contains "linux start with pid 0: could not confirm" "$(out "$work")" "COULD NOT CONFIRM the runner is started"
rm -rf "$work"

# --- macos-daemon ---

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'running\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_API=fail
assert_eq "daemon all reads fail: exit 5" "$rc" "5"
assert_contains "daemon all reads fail: left alone" "$(out "$work")" "every read failed, leaving the runner as it is"
assert_not_contains "daemon all reads fail: no bootout" "$(cmds "$work")" "bootout"
assert_not_contains "daemon all reads fail: no disable" "$(cmds "$work")" "disable"
assert_not_contains "daemon all reads fail: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_not_contains "daemon all reads fail: no enable" "$(cmds "$work")" "enable"
assert_eq "daemon all reads fail: still running" "$(cat "$work/unit_state")" "running"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'running\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=first_time_contributors
assert_eq "daemon wrong policy: exit 1" "$rc" "1"
assert_contains "daemon wrong policy: disable" "$(cmds "$work")" "launchctl disable system/com.example.runner"
assert_contains "daemon wrong policy: bootout" "$(cmds "$work")" "launchctl bootout system/com.example.runner"
assert_not_contains "daemon wrong policy: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_eq "daemon wrong policy: now unloaded" "$(cat "$work/unit_state")" "unloaded"
assert_eq "daemon wrong policy: now disabled" "$(cat "$work/enabled")" "disabled"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'unloaded\n' > "$work/unit_state"
printf 'disabled\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_API=fail
assert_eq "daemon confirmed-stop + failed read: exit 5" "$rc" "5"
assert_not_contains "daemon confirmed-stop + failed read: no enable" "$(cmds "$work")" "enable"
assert_not_contains "daemon confirmed-stop + failed read: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_eq "daemon confirmed-stop + failed read: still unloaded" "$(cat "$work/unit_state")" "unloaded"
assert_eq "daemon confirmed-stop + failed read: still disabled" "$(cat "$work/enabled")" "disabled"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'unloaded\n' > "$work/unit_state"
printf 'disabled\n' > "$work/enabled"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=all_external_contributors
assert_eq "daemon want + down: exit 0" "$rc" "0"
assert_contains "daemon want + down: enable" "$(cmds "$work")" "launchctl enable system/com.example.runner"
assert_contains "daemon want + down: bootstrap" "$(cmds "$work")" "launchctl bootstrap system /tmp/fake.plist"
assert_not_contains "daemon want + down: no bootout" "$(cmds "$work")" "bootout"
assert_not_contains "daemon want + down: no kickstart" "$(cmds "$work")" "kickstart"
assert_eq "daemon want + down: now running" "$(cat "$work/unit_state")" "running"
rm -rf "$work"

# A running print with a nested coalition after the service-level fields must stay up (no kickstart).
work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'running\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=all_external_contributors
assert_eq "daemon want + up nested coalition: exit 0" "$rc" "0"
assert_contains "daemon want + up nested coalition: stays up" "$(out "$work")" "the runner stays up"
assert_not_contains "daemon want + up nested coalition: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_not_contains "daemon want + up nested coalition: no kickstart" "$(cmds "$work")" "kickstart"
assert_not_contains "daemon want + up nested coalition: no bootout" "$(cmds "$work")" "bootout"
rm -rf "$work"

# Loaded in launchd but not running: do not report stays up, and recover with kickstart, not bootstrap.
work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'loaded\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=all_external_contributors
assert_eq "daemon loaded not running: exit 0" "$rc" "0"
assert_contains "daemon loaded not running: starting" "$(out "$work")" "starting the runner"
assert_contains "daemon loaded not running: kickstart" "$(cmds "$work")" "launchctl kickstart system/com.example.runner"
assert_not_contains "daemon loaded not running: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_eq "daemon loaded not running: now running" "$(cat "$work/unit_state")" "running"
rm -rf "$work"

# Successful registration without a running process is not a confirmed start.
work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'unloaded\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=all_external_contributors LAUNCHCTL_STUB_BOOTSTRAP=loaded-only
assert_eq "daemon bootstrap loaded-only: exit 4" "$rc" "4"
assert_contains "daemon bootstrap loaded-only: could not confirm" "$(out "$work")" "COULD NOT CONFIRM the runner is started"
assert_eq "daemon bootstrap loaded-only: not running" "$(cat "$work/unit_state")" "loaded"
rm -rf "$work"

# unreadable answer is a failed read, not a confirmed policy change
work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
printf '4242\n' > "$work/main_pid"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=not-a-policy
assert_eq "garbage policy: exit 5" "$rc" "5"
assert_contains "garbage policy: left alone" "$(out "$work")" "every read failed, leaving the runner as it is"
assert_not_contains "garbage policy: no disable" "$(cmds "$work")" "systemctl disable"
assert_eq "garbage policy: still active" "$(cat "$work/unit_state")" "active"
rm -rf "$work"

printf '\n%d checks, %s\n' "$ran" "$( (( fail == 0 )) && echo OK || echo FAILED )"
exit "$fail"
