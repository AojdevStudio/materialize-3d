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
if [ "$1" = "is-active" ]; then
  [ "$2" = "--quiet" ] && shift
  shift
  [ "$(cat "$STUB_WORK/unit_state")" = "active" ] && exit 0
  exit 3
fi
if [ "$1" = "stop" ]; then
  printf 'inactive\n' > "$STUB_WORK/unit_state"
  exit 0
fi
if [ "$1" = "start" ]; then
  if [ "${SYSTEMCTL_STUB_START:-ok}" = "fail" ]; then exit 1; fi
  printf 'active\n' > "$STUB_WORK/unit_state"
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
    system/*)
      [ "$(cat "$STUB_WORK/unit_state")" = "loaded" ] && exit 0
      exit 113
      ;;
    gui/*/*)
      [ "$(cat "$STUB_WORK/unit_state")" = "loaded" ] && exit 0
      exit 1
      ;;
    gui/*)
      exit 0
      ;;
  esac
  exit 99
fi
if [ "$1" = "bootout" ]; then
  printf 'unloaded\n' > "$STUB_WORK/unit_state"
  exit 0
fi
if [ "$1" = "bootstrap" ]; then
  if [ "${LAUNCHCTL_STUB_BOOTSTRAP:-ok}" = "fail" ]; then exit 1; fi
  printf 'loaded\n' > "$STUB_WORK/unit_state"
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
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_API=fail
assert_eq "linux all reads fail: exit 0" "$rc" "0"
assert_contains "linux all reads fail: left alone" "$(out "$work")" "every read failed, leaving the runner as it is"
assert_not_contains "linux all reads fail: no stop" "$(cmds "$work")" "systemctl stop"
assert_not_contains "linux all reads fail: no start" "$(cmds "$work")" "systemctl start"
assert_eq "linux all reads fail: still active" "$(cat "$work/unit_state")" "active"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=first_time_contributors
assert_eq "linux wrong policy: exit 1" "$rc" "1"
assert_contains "linux wrong policy: stopping" "$(out "$work")" "stopping the runner"
assert_contains "linux wrong policy: stop recorded" "$(cmds "$work")" "systemctl stop fake.unit"
assert_not_contains "linux wrong policy: no start" "$(cmds "$work")" "systemctl start"
assert_eq "linux wrong policy: now inactive" "$(cat "$work/unit_state")" "inactive"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=all_external_contributors
assert_eq "linux want + down: exit 0" "$rc" "0"
assert_contains "linux want + down: starting" "$(out "$work")" "starting the runner"
assert_contains "linux want + down: started" "$(out "$work")" "started fake.unit"
assert_contains "linux want + down: start recorded" "$(cmds "$work")" "systemctl start fake.unit"
assert_not_contains "linux want + down: no stop" "$(cmds "$work")" "systemctl stop"
assert_eq "linux want + down: now active" "$(cat "$work/unit_state")" "active"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=all_external_contributors
assert_eq "linux want + up: exit 0" "$rc" "0"
assert_contains "linux want + up: stays up" "$(out "$work")" "the runner stays up"
assert_not_contains "linux want + up: no start" "$(cmds "$work")" "systemctl start"
assert_not_contains "linux want + up: no stop" "$(cmds "$work")" "systemctl stop"
assert_eq "linux want + up: still active" "$(cat "$work/unit_state")" "active"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'inactive\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=all_external_contributors SYSTEMCTL_STUB_START=fail
assert_eq "linux start fails: exit 4" "$rc" "4"
assert_contains "linux start fails: could not confirm" "$(out "$work")" "COULD NOT CONFIRM the runner is started"
assert_eq "linux start fails: still inactive" "$(cat "$work/unit_state")" "inactive"
rm -rf "$work"

# --- macos-daemon ---

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'loaded\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_API=fail
assert_eq "daemon all reads fail: exit 0" "$rc" "0"
assert_contains "daemon all reads fail: left alone" "$(out "$work")" "every read failed, leaving the runner as it is"
assert_not_contains "daemon all reads fail: no bootout" "$(cmds "$work")" "bootout"
assert_not_contains "daemon all reads fail: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_eq "daemon all reads fail: still loaded" "$(cat "$work/unit_state")" "loaded"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'loaded\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=first_time_contributors
assert_eq "daemon wrong policy: exit 1" "$rc" "1"
assert_contains "daemon wrong policy: bootout" "$(cmds "$work")" "launchctl bootout system/com.example.runner"
assert_not_contains "daemon wrong policy: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_eq "daemon wrong policy: now unloaded" "$(cat "$work/unit_state")" "unloaded"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'unloaded\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=all_external_contributors
assert_eq "daemon want + down: exit 0" "$rc" "0"
assert_contains "daemon want + down: bootstrap" "$(cmds "$work")" "launchctl bootstrap system /tmp/fake.plist"
assert_not_contains "daemon want + down: no bootout" "$(cmds "$work")" "bootout"
assert_eq "daemon want + down: now loaded" "$(cat "$work/unit_state")" "loaded"
rm -rf "$work"

work="$(mktemp -d)"
write_stubs "$work"
printf 'com.example.runner\n' > "$work/label"
printf 'loaded\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" macos-daemon /tmp/fake.plist GH_STUB_POLICY=all_external_contributors
assert_eq "daemon want + up: exit 0" "$rc" "0"
assert_contains "daemon want + up: stays up" "$(out "$work")" "the runner stays up"
assert_not_contains "daemon want + up: no bootstrap" "$(cmds "$work")" "bootstrap"
assert_not_contains "daemon want + up: no bootout" "$(cmds "$work")" "bootout"
rm -rf "$work"

# unreadable answer is a failed read, not a confirmed policy change
work="$(mktemp -d)"
write_stubs "$work"
printf 'active\n' > "$work/unit_state"
: > "$work/cmds"
run_guard "$work" linux fake.unit GH_STUB_POLICY=not-a-policy
assert_eq "garbage policy: exit 0" "$rc" "0"
assert_contains "garbage policy: left alone" "$(out "$work")" "every read failed, leaving the runner as it is"
assert_not_contains "garbage policy: no stop" "$(cmds "$work")" "systemctl stop"
assert_eq "garbage policy: still active" "$(cat "$work/unit_state")" "active"
rm -rf "$work"

printf '\n%d checks, %s\n' "$ran" "$( (( fail == 0 )) && echo OK || echo FAILED )"
exit "$fail"
