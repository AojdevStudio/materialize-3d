#!/usr/bin/env bash
# Decides whether the CAD runtime jobs do their full work for this event, and prints `relevant=true` or
# `relevant=false` for $GITHUB_OUTPUT:
#   scripts/ci/cad-runtime-scope.sh <event name> [<base sha> <head sha>]
# A push to main and a manual dispatch always do. A pull request does when it changes a path in
# scripts/ci/cad-runtime-paths.txt, compared with its merge base; otherwise the jobs still run and succeed fast, so
# their check-runs are present and green on every pull request once they are required checks. The key script reads
# the same list (scripts/ci/cad-runtime-key.sh), so what counts as a runtime input is decided in one place.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
paths_text="$(grep -Ev '^[[:space:]]*(#|$)' "$here/cad-runtime-paths.txt")"
mapfile -t paths <<< "$paths_text"
event="${1:?event name}"
if [[ "$event" != pull_request ]]; then
  echo "relevant=true"
  exit 0
fi
base="${2:?base sha}" head="${3:?head sha}"
merge_base="$(git -C "$root" merge-base "$base" "$head")"
# The list goes through a file so a failed diff stops the job instead of reading as "nothing changed". Without rename
# detection, a file moved out of a listed path shows up under its old name.
changed="$(mktemp)"
trap 'rm -f "$changed"' EXIT
GIT_LITERAL_PATHSPECS=1 git -C "$root" diff --no-renames --name-only -z "$merge_base" "$head" -- "${paths[@]}" > "$changed"
if [[ -s "$changed" ]]; then
  IFS= read -r -d '' file < "$changed" || true
  echo "scope: $file changed" >&2
  echo "relevant=true"
else
  echo "scope: nothing under ${paths[*]} changed since $merge_base" >&2
  echo "relevant=false"
fi
