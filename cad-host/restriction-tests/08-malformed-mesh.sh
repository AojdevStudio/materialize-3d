#!/usr/bin/env bash
# A fully compromised inspection guest (cad-runtime/test/hostile-guest.c) cannot get a malformed mesh or frame
# past the host: each hostile answer is rejected, and a valid control answer is accepted on the same path.
# PASS when every hostile case ends in outcome rejected and the control in accepted.
source "$(dirname "$0")/lib.sh"
out="$(case_dir valid)"
run_helper hostile --case valid --deadline-s 30 --out "$out"
check "control: a valid mesh from the same guest is accepted" test "$(field "$out" .outcome)" = accepted
check "control: and it is a closed manifold" test "$(field "$out" '.bodies[0].mesh.closed_manifold')" = true
for case in nan inf far index huge-count zero-bodies empty-body trailing big-frame bad-tag duplicate wrong-role; do
  out="$(case_dir "$case")"
  run_helper hostile --case "$case" --deadline-s 30 --out "$out"
  check "$case: rejected ($(field "$out" .error))" test "$(field "$out" .outcome)" = rejected
done
check "no VM is left running" no_vm_running
finish
