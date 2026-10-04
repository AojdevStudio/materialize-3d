#!/usr/bin/env bash
# Decides whether the CAD runtime jobs do their full work for this event, and prints `relevant=true` or
# `relevant=false` for $GITHUB_OUTPUT:
#   scripts/ci/cad-runtime-scope.sh <event name> [<base sha> <head sha>]
# A push to main and a manual dispatch always do. A pull request does when it changes a path below, compared with
# its merge base; otherwise the jobs still run and succeed fast, so their check-runs are present and green on
# every pull request once they are required checks. An app file that compiles in or reads the CAD runtime pins
# (none yet; PR 7's cad_worker.rs will) belongs on this list.
set -euo pipefail
paths=(
  cad-runtime/
  cad-host/
  scripts/release/
  scripts/ci/cad-runtime-scope.sh
  .github/workflows/cad-runtime.yml
)
event="${1:?event name}"
if [[ "$event" != pull_request ]]; then
  echo "relevant=true"
  exit 0
fi
base="${2:?base sha}" head="${3:?head sha}"
merge_base="$(git merge-base "$base" "$head")"
# The list goes through a file so a failed diff stops the job instead of reading as "nothing changed".
changed="$(mktemp)"
trap 'rm -f "$changed"' EXIT
git diff --name-only -z "$merge_base" "$head" > "$changed"
while IFS= read -r -d '' file; do
  for path in "${paths[@]}"; do
    if [[ "$file" == "$path"* ]]; then
      echo "scope: $file changed" >&2
      echo "relevant=true"
      exit 0
    fi
  done
done < "$changed"
echo "scope: nothing under ${paths[*]} changed since $merge_base" >&2
echo "relevant=false"
