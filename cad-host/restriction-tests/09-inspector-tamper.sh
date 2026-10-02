#!/usr/bin/env bash
# The inspector cannot be tampered with. From inside, a generation job cannot write it and its planted mesh and
# verdict never reach the host, because the inspection guest boots the read-only image with a fresh job disk.
# From outside, a runtime whose image or kernel changed by one byte is refused before any VM boots.
# PASS when the in-guest writes fail, the honest cube comes back from inspection, the pinned files are unchanged,
# and both tampered copies are refused with no VM started.
source "$(dirname "$0")/lib.sh"
out="$(case_dir from-inside)"
run_helper build --source "$JOBS/plant-inspector.py" --params "$JOBS/empty.json" --deadline-s 120 --out "$out"
check "inside: both writes to the inspector were blocked" test "$(grep -c ': blocked' "$out/diagnostics-generate.txt")" = 2
check "inside: the build was accepted" test "$(field "$out" .outcome)" = accepted
check "inside: inspection returned the honest 10 mm cube" test "$(field "$out" '.bodies[0].mesh.bbox_max_mm | map(. * 1000 | round) | join(",")')" = "5000,5000,5000"
check "inside: and it is closed" test "$(field "$out" '.bodies[0].mesh.closed_manifold')" = true
check "inside: the runtime files still match their pins" runtime_unchanged
for name in rootfs.img Image; do
  copy="$OUT_ROOT/$test_name/tampered-$name"
  rm -rf "$copy" && mkdir -p "$copy" && cp -c "$RUNTIME"/* "$copy/"
  printf '\x01' | dd of="$copy/$name" bs=1 seek=4096 conv=notrunc status=none
  out="$(case_dir "outside-$name")"
  RUNTIME="$copy" run_helper generate --source "$JOBS/plant-inspector.py" --params "$JOBS/empty.json" --deadline-s 60 --out "$out"
  check "outside: a one-byte change to $name is refused" test "$(field "$out" .outcome)" = unverified
  check "outside: refused before any VM booted ($name)" test "$(field "$out" .guest)" = null
  rm -rf "$copy"
done
check "no VM is left running" no_vm_running
finish
