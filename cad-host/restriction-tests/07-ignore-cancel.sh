#!/usr/bin/env bash
# A job that ignores signals cannot outlive a cancel, and a guest that never answers cannot outlive the deadline:
# the host force-stops the VM either way, including a cancel that lands while the VM is still starting (when the
# framework does not yet allow a stop).
# PASS when each stop lands within 3 s of the cancel or deadline, the host forced each stop and the framework
# confirmed the VM stopped, and no VM process remains.
source "$(dirname "$0")/lib.sh"
out="$(case_dir cancel)"
run_helper generate --source "$JOBS/ignore-cancel.py" --params "$JOBS/empty.json" --deadline-s 120 --cancel-after-s 10 --out "$out"
check "cancel: outcome deadline (cancelled)" grep -q cancelled <(field "$out" .error)
check "cancel: the VM was force-stopped" test "$(field "$out" .guest.timings.forced_stop)" = true
check "cancel: the VM ended stopped" test "$(field "$out" .guest.timings.final_state)" = stopped
check "cancel: the helper returned within 13 s" test "$(cat "$out/wall_s")" -le 13
check "cancel: no VM is left running" no_vm_running
out="$(case_dir cancel-while-starting)"
run_helper generate --source "$JOBS/ignore-cancel.py" --params "$JOBS/empty.json" --deadline-s 120 --cancel-after-s 0 --out "$out"
check "cancel at start: outcome deadline (cancelled)" grep -q cancelled <(field "$out" .error)
check "cancel at start: the VM was force-stopped" test "$(field "$out" .guest.timings.forced_stop)" = true
check "cancel at start: the VM ended stopped" test "$(field "$out" .guest.timings.final_state)" = stopped
check "cancel at start: no VM is left running" no_vm_running
out="$(case_dir silent-guest)"
run_helper hostile --case silent --deadline-s 15 --out "$out"
check "deadline: outcome deadline" test "$(field "$out" .outcome)" = deadline
check "deadline: the VM was force-stopped" test "$(field "$out" .guest.timings.forced_stop)" = true
check "deadline: the VM ended stopped" test "$(field "$out" .guest.timings.final_state)" = stopped
check "deadline: the helper returned within 18 s" test "$(cat "$out/wall_s")" -le 18
check "deadline: no VM is left running" no_vm_running
finish
