#!/usr/bin/env bash
# Prints the kernel rebuild stamp: one sha256 over every input that decides a kernel's bytes. build.sh reuses a
# kernel only when its stamp matches, so changing any of these rebuilds it:
#   the architecture, the Debian snapshot that selects the toolchain, the tools image that holds that toolchain,
#   and the files that pin the source and its signer and set the config and build flags.
#   cad-runtime/kernel/stamp.sh <arm64|amd64> <debian snapshot> <tools image id>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $# -eq 3 && -n "$2" && -n "$3" ]] || { echo "usage: $0 <arm64|amd64> <debian snapshot> <tools image id>" >&2; exit 2; }
arch="$1" snapshot="$2" tools="$3"
{
  printf 'arch=%s\ndebian_snapshot=%s\ntools_image=%s\n' "$arch" "$snapshot" "$tools"
  cat "$here/kernel/pins.env" "$here/kernel/$arch.config" "$here/kernel/build-kernel.sh" \
    "$here/kernel/kernel-signing-keys.asc" "$here/image/tools.Dockerfile" "$here/image/snapshot.sources"
} | sha256sum | cut -d' ' -f1
