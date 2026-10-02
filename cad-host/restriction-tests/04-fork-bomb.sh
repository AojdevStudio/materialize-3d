#!/usr/bin/env bash
# A fork bomb stops at the job's process cap and the guest still answers.
# PASS when forks are refused at the cap, the host gets a bounded failure well inside the deadline, and the VM
# is stopped.
source "$(dirname "$0")/lib.sh"
out="$(case_dir run)"
run_helper generate --source "$JOBS/fork-bomb.py" --params "$JOBS/empty.json" --deadline-s 90 --out "$out"
check "the job failed with a bounded error" test "$(field "$out" .outcome)" = job_failed
check "forks were refused" grep -q 'fork refused after' "$out/diagnostics-generate.txt"
check "the process count peaked at the cap of 64" test "$(field "$out" .guest.stats.pids_peak)" -le 64
check "the guest answered well inside the deadline" test "$(cat "$out/wall_s")" -lt 60
check "no VM is left running" no_vm_running
finish
