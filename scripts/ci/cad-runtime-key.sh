#!/usr/bin/env bash
# The CAD runtime key:
#   scripts/ci/cad-runtime-key.sh                          prints key=<hex>
# The key is the sha256 of `git ls-files -s -z` over the paths in scripts/ci/cad-runtime-paths.txt, which lists the
# workflow, that list, and this script as well. Each entry carries mode, blob id, and path, so a change of content,
# mode, or file set under a listed path gives a new key, and a change anywhere else does not. A listed path that
# matches no tracked file is an error, not an empty contribution.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
paths_text="$(grep -Ev '^[[:space:]]*(#|$)' "$here/cad-runtime-paths.txt")"
mapfile -t paths <<< "$paths_text"
key="$(GIT_LITERAL_PATHSPECS=1 git -C "$root" ls-files -s -z --error-unmatch -- "${paths[@]}" | sha256sum)"
key="${key%% *}"
[[ "$key" =~ ^[0-9a-f]{64}$ ]] || { echo "cad-runtime key: sha256sum gave no digest" >&2; exit 1; }

case "${1:-}" in
  "")
    echo "key=$key"
    ;;
  *)
    echo "usage: $0" >&2
    exit 2
    ;;
esac
