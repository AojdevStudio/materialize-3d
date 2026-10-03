#!/usr/bin/env bash
# The kernel rebuild stamp follows every input that selects the kernel's toolchain or bytes, so build.sh rebuilds
# the kernel when one changes (a new DEBIAN_SNAPSHOT included) and reuses it when none does.
#   cad-runtime/test/kernel-stamp.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "kernel stamp: FAIL $*" >&2; exit 1; }
stamp() { "$here/kernel/stamp.sh" "$@"; }
base="$(stamp arm64 20260918T000000Z sha256:1111)"
[[ "$(stamp arm64 20260918T000000Z sha256:1111)" == "$base" ]] || fail "the same inputs gave a different stamp"
[[ "$(stamp arm64 20261001T000000Z sha256:1111)" != "$base" ]] || fail "a new DEBIAN_SNAPSHOT kept the stamp"
[[ "$(stamp arm64 20260918T000000Z sha256:2222)" != "$base" ]] || fail "a new tools image kept the stamp"
[[ "$(stamp amd64 20260918T000000Z sha256:1111)" != "$base" ]] || fail "the other architecture kept the stamp"
# build.sh must stamp with the snapshot and tools image it actually builds with, and compare before reusing.
grep -qF 'stamp="$("$here/kernel/stamp.sh" "$arch" "$DEBIAN_SNAPSHOT" "$tools_image")"' "$here/build.sh" \
  || fail "build.sh does not stamp the kernel with its DEBIAN_SNAPSHOT and tools image"
grep -qF '"$(cat "$out/kernel.stamp" 2>/dev/null)" != "$stamp"' "$here/build.sh" \
  || fail "build.sh does not compare the stamp before reusing a kernel"
echo "kernel stamp: a new DEBIAN_SNAPSHOT, tools image, or architecture forces a rebuild"
