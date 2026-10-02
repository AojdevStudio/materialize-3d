#!/usr/bin/env bash
# A job's error comes back as a bounded prefix inside the host's caps however long or escape-heavy its text is:
# 3,000 CJK characters, 3,000 control characters (each escapes to six bytes of JSON), and a job that writes its own
# 60 KB verdict and exits. Added in review: the guest had bounded errors by characters, not serialized bytes, so
# these came back as a generic "job exited with 1".
# PASS when each run fails as job_failed with an error that starts with the job's own text and whose JSON encoding
# keeps at least 1,500 bytes of it and fits in the 2,048-byte error budget.
source "$(dirname "$0")/lib.sh"
expect() { # case, expected start of the error
  local out serialized
  out="$(case_dir "$1")"
  run_helper generate --source "$JOBS/long-error.py" --params "$JOBS/long-error-$1.json" --deadline-s 60 --out "$out"
  serialized="$(jq '.error | tojson | utf8bytelength' "$out/result.json")"
  check "$1: the job failed with its own error" test "$(field "$out" .outcome)" = job_failed
  check "$1: the error starts with the job's text" test "$(jq --arg p "$2" '.error | startswith($p)' "$out/result.json")" = true
  check "$1: the error keeps a useful prefix ($serialized bytes as JSON)" test "$serialized" -ge 1500
  check "$1: the error fits the 2,048-byte budget" test "$serialized" -le 2048
}
expect cjk "line 12: RuntimeError: $(printf '\xe7\x95\x8c%.0s' 1 2 3)"
expect control $'line 12: RuntimeError: \x01\x01\x01'
expect planted "$(printf '\xe7\x95\x8c%.0s' 1 2 3)"
check "no VM is left running" no_vm_running
finish
