#!/usr/bin/env bash
# A job that writes without limit fills only its own fixed-size job disk and tmpfs, never the Mac's disk.
# PASS when both areas end in ENOSPC, the job disk file is exactly its fixed size, and the job disk is deleted.
source "$(dirname "$0")/lib.sh"
out="$(case_dir run)"
template_bytes="$(stat -f %z "$RUNTIME/job.img")"
run_helper generate --source "$JOBS/disk.py" --params "$JOBS/empty.json" --deadline-s 120 --out "$out"
check "the job disk filled to ENOSPC" grep -q '^/job/out: wrote .* then ENOSPC' "$out/diagnostics-generate.txt"
check "the 64 MiB tmpfs filled to ENOSPC" grep -q '^/tmp: wrote 6[0-4] MiB then ENOSPC' "$out/diagnostics-generate.txt"
check "the job disk file kept its fixed size" test "$(field "$out" .guest.job_disk.bytes)" = "$template_bytes"
check "the job disk allocated no more than its size" test "$(field "$out" .guest.job_disk.allocated_bytes)" -le "$template_bytes"
check "the job disk was deleted" test ! -e "$(field "$out" .guest.job_disk.path)"
check "no VM is left running" no_vm_running
finish
