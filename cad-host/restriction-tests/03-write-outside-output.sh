#!/usr/bin/env bash
# A job can write only its own output area: the root image, the inspector, the inputs, the raw disks, and the
# job disk's root all refuse it, and it cannot gain root to change that.
# PASS when every outside write and privilege attempt fails, the runtime files still match their pins, and the
# job disk is gone after the run.
source "$(dirname "$0")/lib.sh"
out="$(case_dir run)"
run_helper generate --source "$JOBS/write-outside.py" --params "$JOBS/empty.json" --deadline-s 90 --out "$out"
check "the job ran and reported no breach" grep -q 'breaches=0' <(field "$out" .error)
check "all ten outside writes were blocked" test "$(grep -c '^/.*: blocked' "$out/diagnostics-generate.txt")" = 10
check "remounting the root read-write was blocked" grep -q 'remount / rw: blocked' "$out/diagnostics-generate.txt"
check "setuid(0) and chown were blocked" test "$(grep -cE '^(setuid\(0\)|chown): blocked' "$out/diagnostics-generate.txt")" = 2
# The agent execs the job with an empty environment; CPython's own PEP 538 locale coercion then sets LC_CTYPE
# inside the interpreter. Nothing from the host can appear here.
check "the job was exec'd with an empty environment block" grep -qx "environ=b''" "$out/diagnostics-generate.txt"
check "the job ran unprivileged with an empty environment" grep -qE "uid=1000 gid=1000 groups=\[\] env=(\{\}|\{'LC_CTYPE': 'C.UTF-8'\})$" "$out/diagnostics-generate.txt"
check "the runtime files still match their pins" runtime_unchanged
check "the job disk was deleted" test ! -e "$(field "$out" .guest.job_disk.path)"
check "no VM is left running" no_vm_running
finish
