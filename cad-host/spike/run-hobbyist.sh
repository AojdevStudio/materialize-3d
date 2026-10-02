#!/usr/bin/env bash
# Proxy first-try success rate: each hobbyist script, written cold, runs exactly once through both guests.
# A first-try success is an accepted build whose every body is closed, non-degenerate, and outward.
#   HELPER=... RUNTIME=... cad-host/spike/run-hobbyist.sh [log]
set -uo pipefail
: "${HELPER:?}" "${RUNTIME:?}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${OUT:-$here/../out/hobbyist}"
log="${1:-$out/hobbyist.log}"
rm -rf "$out" && mkdir -p "$out"
{
  echo "hobbyist first-try run, $(date -u +%FT%TZ), one attempt each, no edits after writing"
  ok=0 total=0
  for src in "$here"/hobbyist/[0-9][0-9]-*.py; do
    name="$(basename "$src" .py)" && d="$out/$name" && mkdir -p "$d"
    "$HELPER" build --runtime "$RUNTIME" --source "$src" --params "${src%.py}.params.json" --out "$d" > /dev/null 2>&1
    total=$((total + 1))
    verdict="$(jq -r 'if .outcome != "accepted" then "FAIL (\(.outcome)): \(.error)"
      elif all(.bodies[]; .mesh.closed_manifold and .mesh.non_degenerate and .mesh.outward) then "ok"
      else "FAIL (geometry): " + ([.bodies[] | "\(.name): closed \(.mesh.closed_manifold), boundary edges \(.mesh.boundary_edges), non-degenerate \(.mesh.non_degenerate)"] | join("; ")) end' "$d/result.json")"
    [[ "$verdict" == ok ]] && ok=$((ok + 1))
    echo "$name: $verdict"
  done
  echo "first-try success: $ok of $total"
} 2>&1 | tee "$log"
