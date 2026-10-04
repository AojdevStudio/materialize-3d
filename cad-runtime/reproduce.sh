#!/usr/bin/env bash
# Proves the CAD runtime for one architecture is reproducible:
#   cad-runtime/reproduce.sh <arm64|amd64>
# Builds the runtime twice from the pinned inputs, each time into a fresh directory and without Docker's build
# cache. Passes only when both builds give byte-identical outputs and those match the committed pins-<arch>.json,
# the pins the helper compiles in. The first build stays in cad-runtime/out/<arch>/ for the jobs that use it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="${1:-}"
[[ "$arch" == arm64 || "$arch" == amd64 ]] || { echo "usage: $0 <arm64|amd64>" >&2; exit 2; }
first="$here/out/$arch" second="$here/out/$arch-second"
rm -rf "$first" "$second"
for dir in "$first" "$second"; do
  started=$(date +%s)
  M3D_CAD_OUT="$dir" M3D_CAD_NO_CACHE=1 "$here/build.sh" "$arch" >/dev/null
  echo "reproduce: clean $arch build into $dir took $(($(date +%s) - started)) s"
done
cmp -s "$first/pins.json" "$second/pins.json" || {
  echo "reproduce: two clean $arch builds differ:" >&2
  diff "$first/pins.json" "$second/pins.json" >&2 || true
  exit 1
}
echo "reproduce: both clean $arch builds have the same digests"
cmp -s "$first/pins.json" "$here/pins-$arch.json" || {
  echo "reproduce: the $arch build does not match the committed pins-$arch.json:" >&2
  diff "$here/pins-$arch.json" "$first/pins.json" >&2 || true
  exit 1
}
echo "reproduce: the $arch build matches pins-$arch.json"
cat "$first/pins.json"
rm -rf "$second"
