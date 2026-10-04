#!/usr/bin/env bash
# The CAD runtime key, and the record of a run that passed under it:
#   scripts/ci/cad-runtime-key.sh [--backend]                          prints key=<hex>
#   scripts/ci/cad-runtime-key.sh [--backend] record <run id> <file>   writes the record for this key to <file>, prints
#                                                                      key=<hex>
#   scripts/ci/cad-runtime-key.sh [--backend] lookup <owner/repo>      exits 0 and prints source_run=<id> and key=<hex>
#                                                                      only when a passed run carries the record for
#                                                                      this key; exits 1 otherwise
# The key is the sha256 of `git ls-files -s -z` over the paths in scripts/ci/cad-runtime-paths.txt, which lists the
# workflow, that list, and this script as well. With --backend it is the part-kind jobs' key instead: the same over
# that list and scripts/ci/cad-backend-paths.txt together (the app's Rust and test inputs), recorded as
# cad-backend-pass-<key>. A change to the app alone moves only the part-kind key, never the image key. Each entry carries mode, blob id, and path, so a change of content,
# mode, or file set under a listed path gives a new key, and a change anywhere else does not. A listed path that
# matches no tracked file is an error, not an empty contribution.
# The record is the artifact cad-runtime-pass-<key>, which cad-runtime.yml uploads only after both CAD jobs did their
# full work and passed (cad-backend-pass-<key> after both part-kind jobs did). Only the run's own jobs can upload into a run, so `lookup` trusts an artifact only through its
# run: a completed, successful run of .github/workflows/cad-runtime.yml whose head is in this repository, whose actor
# and triggering actor are both named, and neither of them Dependabot. It reads every page of the artifact list (a
# total_count from 1 to 5000, so at most 50 pages) and checks every candidate run. Any failure to read or check that
# is a miss, never a hit. `lookup` reads GH_TOKEN, which needs actions: read (docs/ci-runners.md).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
lists=("$here/cad-runtime-paths.txt") record_prefix=cad-runtime-pass
if [[ "${1:-}" == --backend ]]; then
  lists+=("$here/cad-backend-paths.txt") record_prefix=cad-backend-pass
  shift
fi
paths_text="$(grep -hEv '^[[:space:]]*(#|$)' "${lists[@]}")"
mapfile -t paths <<< "$paths_text"
key="$(GIT_LITERAL_PATHSPECS=1 git -C "$root" ls-files -s -z --error-unmatch -- "${paths[@]}" | sha256sum)"
key="${key%% *}"
[[ "$key" =~ ^[0-9a-f]{64}$ ]] || { echo "cad-runtime key: sha256sum gave no digest" >&2; exit 1; }

case "${1:-}" in
  "")
    echo "key=$key"
    ;;
  record)
    run_id="${2:?run id}" file="${3:?record file}"
    [[ "$run_id" =~ ^[0-9]+$ ]] || { echo "cad-runtime key: run id '$run_id' is not a number" >&2; exit 1; }
    printf 'run_id=%s\nhash=%s\n' "$run_id" "$key" > "$file"
    echo "key=$key"
    ;;
  lookup)
    repo="${2:?owner/repo}" name="$record_prefix-$key"
    miss() { echo "cad-runtime key: miss, $*" >&2; exit 1; }
    [[ -n "${GH_TOKEN:-}" ]] || miss "GH_TOKEN is not set"
    # The token goes in on stdin, so it stays out of argv on the runner host.
    api() {
      curl -fsS --retry 3 --max-time 30 -H @- -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/$repo/$1" <<< "Authorization: Bearer $GH_TOKEN"
    }
    # Every page is read before any run is checked, so a failure on any page is a miss, never a partial answer. jq
    # accepts a page only when total_count is an integer from 1 to 5000 (50 pages of 100) and prints it as a plain
    # decimal integer, so bash does arithmetic only on a checked value. The first page's total_count fixes how many pages there are. A page that fails, is not
    # such a list, reports another total, or holds no artifact unseen on earlier pages is a miss. A short page is the
    # last.
    page=1 pages=1 total="" ids=()
    declare -A seen=()
    while (( page <= pages )); do
      artifacts="$(api "actions/artifacts?name=$name&per_page=100&page=$page")" \
        || miss "page $page of the artifact list for $name did not load"
      if (( page == 1 )) && jq -e '.total_count == 0 and .artifacts == []' <<< "$artifacts" > /dev/null 2>&1; then
        miss "no artifact is named $name"
      fi
      page_text="$(jq -r --arg name "$name" --argjson max_total 5000 '
        if (.total_count | if type == "number" then . == floor and . >= 1 and . <= $max_total else false end)
          and (.artifacts | type) == "array" then
          (.total_count | floor | tostring), (.artifacts | length | tostring),
          (.artifacts[] | "\(.id) \(if .name == $name then .workflow_run.id else "-" end)")
        else error("not an artifact list") end' <<< "$artifacts")" \
        || miss "page $page of the artifact list for $name is not a list with a total_count from 1 to 5000"
      mapfile -t lines <<< "$page_text"
      # jq keeps the notation it read (1e3, 1.0); floor above prints the plain integer, and bash checks it again.
      [[ "${lines[0]}" =~ ^[1-9][0-9]{0,3}$ ]] \
        || miss "page $page of the artifact list for $name gave total_count '${lines[0]}', not a plain integer"
      if (( page == 1 )); then
        total="${lines[0]}" pages=$(( (lines[0] + 99) / 100 ))
      fi
      [[ "${lines[0]}" == "$total" ]] || miss "the artifact list for $name changed while it was read"
      new=0
      for line in "${lines[@]:2}"; do
        artifact="${line%% *}" run_id="${line#* }"
        [[ -z "${seen[$artifact]:-}" ]] || continue
        seen[$artifact]=1 new=$((new + 1))
        [[ "$run_id" == - ]] || ids+=("$run_id")
      done
      (( page == 1 || new > 0 )) || miss "page $page of the artifact list for $name repeats earlier artifacts"
      (( lines[1] == 100 )) || break
      page=$((page + 1))
    done
    # Newest run first; every candidate is checked.
    runs_text="$(printf '%s\n' "${ids[@]}" | { grep -E '^[0-9]+$' || true; } | sort -rnu)"
    mapfile -t runs <<< "$runs_text"
    for run_id in "${runs[@]}"; do
      [[ "$run_id" =~ ^[0-9]+$ ]] || continue
      run="$(api "actions/runs/$run_id")" || { echo "cad-runtime key: run $run_id did not load" >&2; continue; }
      if jq -e --arg repo "$repo" --argjson id "$run_id" '
        .id == $id and .path == ".github/workflows/cad-runtime.yml"
        and .status == "completed" and .conclusion == "success"
        and (.event == "pull_request" or .event == "push" or .event == "workflow_dispatch")
        and .repository.full_name == $repo and .head_repository.full_name == $repo
        and ([.actor.login, .triggering_actor.login]
          | all(type == "string" and . != "" and . != "dependabot[bot]"))' <<< "$run" > /dev/null
      then
        echo "source_run=$run_id"
        echo "key=$key"
        exit 0
      fi
      echo "cad-runtime key: run $run_id is not a passed cad-runtime.yml run from $repo" >&2
    done
    miss "no passed cad-runtime.yml run from $repo carries $name"
    ;;
  *)
    echo "usage: $0 [--backend] [record <run id> <file> | lookup <owner/repo>]" >&2
    exit 2
    ;;
esac
