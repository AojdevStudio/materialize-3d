#!/usr/bin/env bash
# A job cannot read a host file: a canary token written on the Mac never reaches the guest or comes back.
# PASS when the token appears in nothing the host received and the guest sees no host share.
source "$(dirname "$0")/lib.sh"
out="$(case_dir run)"
token="M3D-CANARY-$(uuidgen)"
mkdir -p "$out/../host-files" && printf '%s\n' "$token" > "$out/../host-files/canary.txt"
run_helper generate --source "$JOBS/canary.py" --params "$JOBS/empty.json" --deadline-s 90 --out "$out"
check "the job ran and reported (outcome job_failed)" test "$(field "$out" .outcome)" = job_failed
check "the job scanned the guest filesystem" grep -q 'scanned=[1-9]' "$out/diagnostics-generate.txt"
check "the guest found no canary" grep -q 'canary_found=0' "$out/diagnostics-generate.txt"
check "the guest sees no virtiofs, 9p, FUSE, NFS, or CIFS mount" grep -q 'shares=0' "$out/diagnostics-generate.txt"
check "the guest has only its two disks" grep -q 'block_devices=vda,vdb$' "$out/diagnostics-generate.txt"
check "the token is in nothing the host received" bash -c "! grep -rqF '$token' '$out'"
check "no VM is left running" no_vm_running
finish
