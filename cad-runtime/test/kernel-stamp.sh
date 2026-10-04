#!/usr/bin/env bash
# The kernel is rebuilt exactly when an input that decides its bytes changes:
#   cad-runtime/test/kernel-stamp.sh [amd64|arm64]
# 1. kernel/stamp.sh gives a new stamp for a new DEBIAN_SNAPSHOT, tools image, or architecture, and the same stamp
#    for the same inputs.
# 2. Two real build.sh runs in a row into one output directory, with Docker's cache: the second builds the same
#    tools image (same id), keeps the same stamp, and reuses the kernel instead of building it again. The stamp
#    build.sh records is the one stamp.sh gives for the snapshot pins.json names and the tools image it built.
# Part 2 runs Docker on this host and takes a few minutes; amd64 is the faster architecture.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
arch="${1:-amd64}"
fail() { echo "kernel stamp: FAIL $*" >&2; exit 1; }
stamp() { "$here/kernel/stamp.sh" "$@"; }

base="$(stamp "$arch" 20260918T000000Z sha256:1111)"
[[ "$(stamp "$arch" 20260918T000000Z sha256:1111)" == "$base" ]] || fail "the same inputs gave a different stamp"
[[ "$(stamp "$arch" 20261001T000000Z sha256:1111)" != "$base" ]] || fail "a new DEBIAN_SNAPSHOT kept the stamp"
[[ "$(stamp "$arch" 20260918T000000Z sha256:2222)" != "$base" ]] || fail "a new tools image kept the stamp"
other=arm64
[[ "$arch" == arm64 ]] && other=amd64
[[ "$(stamp "$other" 20260918T000000Z sha256:1111)" != "$base" ]] || fail "the other architecture kept the stamp"

out="$(mktemp -d "${TMPDIR:-/tmp}/m3d-kernel-stamp.XXXXXX")"
trap 'rm -rf "$out"' EXIT
kernel=Image
[[ "$arch" == amd64 ]] && kernel=vmlinux
M3D_CAD_OUT="$out" "$here/build.sh" "$arch" > /dev/null 2> "$out/first.err" \
  || { cat "$out/first.err" >&2; fail "the first build failed"; }
first_tools="$(cat "$out/tools.iid")" first_stamp="$(cat "$out/kernel.stamp")"
first_kernel="$(sha256sum < "$out/$kernel")" first_mtime="$(stat -c %Y "$out/$kernel")"
M3D_CAD_OUT="$out" "$here/build.sh" "$arch" > /dev/null 2> "$out/second.err" \
  || { cat "$out/second.err" >&2; fail "the second build failed"; }
[[ "$(cat "$out/tools.iid")" == "$first_tools" ]] || fail "the tools image id changed between two builds from the same inputs"
[[ "$(cat "$out/kernel.stamp")" == "$first_stamp" ]] || fail "the kernel stamp changed between two builds from the same inputs"
[[ "$(stat -c %Y "$out/$kernel")" == "$first_mtime" && "$(sha256sum < "$out/$kernel")" == "$first_kernel" ]] \
  || fail "the second build rebuilt the kernel"
if grep -q 'kernel: signature' "$out/second.err"; then fail "the second build ran the kernel build"; fi
snapshot="$(sed -n 's/.*"debian_snapshot": "\([^"]*\)".*/\1/p' "$out/pins.json")"
[[ -n "$snapshot" ]] || fail "pins.json names no debian_snapshot"
[[ "$first_stamp" == "$(stamp "$arch" "$snapshot" "$first_tools")" ]] \
  || fail "build.sh's stamp is not the one for its own DEBIAN_SNAPSHOT ($snapshot) and tools image"
echo "kernel stamp: new inputs change the stamp; two $arch builds from the same inputs built tools image $first_tools and the kernel once"
