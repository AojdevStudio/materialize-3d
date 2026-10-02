#!/usr/bin/env bash
# A job cannot reach any network: no IP route out, no DNS, and the only host vsock port refuses it.
# PASS when every attempt is blocked, the guest has only a loopback interface, and the host refused the job's
# connection to its one listening port.
source "$(dirname "$0")/lib.sh"
out="$(case_dir run)"
run_helper generate --source "$JOBS/network.py" --params "$JOBS/empty.json" --deadline-s 90 --out "$out"
check "the job ran and reported (outcome job_failed)" test "$(field "$out" .outcome)" = job_failed
check "the guest has only a loopback interface" grep -qx 'interfaces=lo' "$out/diagnostics-generate.txt"
check "all nine attempts were blocked" test "$(grep -c ': blocked' "$out/diagnostics-generate.txt")" = 9
check "nothing connected" bash -c "! grep -q CONNECTED '$out/diagnostics-generate.txt'"
check "the host refused the job's vsock connection" test "$(field "$out" .guest.timings.refused_connections)" -ge 1
check "no VM is left running" no_vm_running
finish
