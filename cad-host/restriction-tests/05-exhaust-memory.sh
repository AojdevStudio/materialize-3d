#!/usr/bin/env bash
# A job that allocates without limit is killed inside the guest's fixed memory, and the agent still reports.
# PASS when the job dies of the memory cap, the agent reports it, and the guest never exceeded its fixed memory.
source "$(dirname "$0")/lib.sh"
out="$(case_dir run)"
run_helper generate --source "$JOBS/memory.py" --params "$JOBS/empty.json" --deadline-s 90 --memory-mib 2048 --out "$out"
check "the job failed with 'ran out of memory'" grep -q 'ran out of memory' <(field "$out" .error)
check "the guest's OOM killer acted" test "$(field "$out" .guest.stats.oom_kills)" -ge 1
check "the job's peak stayed under the 2 GiB guest" test "$(field "$out" .guest.stats.memory_peak)" -lt $((2048 << 20))
check "the job held at least 1 GiB before it was stopped" grep -q 'held 1[0-9][0-9][0-9] MiB' "$out/diagnostics-generate.txt"
check "no VM is left running" no_vm_running
finish
