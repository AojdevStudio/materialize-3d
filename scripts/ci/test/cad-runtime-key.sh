#!/usr/bin/env bash
# The CAD runtime key follows exactly the listed inputs, the scope script reads the same list, and a record matches
# only the key it was written for:
#   scripts/ci/test/cad-runtime-key.sh
# Every case runs in a scratch repository that holds copies of the two scripts and the path list, plus a placeholder
# file under each listed directory, so it never touches this checkout. The cad-runtime workflow runs it before the
# scope step on every event.
set -euo pipefail
ci="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "cad-runtime key test: FAIL $*" >&2; exit 1; }

# A scratch repository must not pick up this machine's git hooks, signing, or identity.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=cad-key-test GIT_AUTHOR_EMAIL=cad-key-test@invalid
export GIT_COMMITTER_NAME=cad-key-test GIT_COMMITTER_EMAIL=cad-key-test@invalid
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/m3d-cad-key.XXXXXX")"
trap 'rm -rf "$work"' EXIT
repo="$work/repo" record="$work/record"
git init -q "$repo"
mkdir -p "$repo/scripts/ci"
cp "$ci/cad-runtime-key.sh" "$ci/cad-runtime-scope.sh" "$ci/cad-runtime-paths.txt" "$repo/scripts/ci/"
while IFS= read -r path; do
  if [[ "$path" == */ ]]; then
    mkdir -p "$repo/$path"
    echo "placeholder for $path" > "$repo/${path}placeholder"
  elif [[ ! -e "$repo/$path" ]]; then
    mkdir -p "$(dirname "$repo/$path")"
    echo "placeholder for $path" > "$repo/$path"
  fi
done < <(grep -Ev '^[[:space:]]*(#|$)' "$ci/cad-runtime-paths.txt")
[[ -f "$repo/cad-runtime/placeholder" && -f "$repo/cad-host/placeholder" ]] \
  || fail "the path list no longer names cad-runtime/ and cad-host/"
mkdir -p "$repo/docs" "$repo/extra"
echo "docs" > "$repo/docs/ci-runners.md"
echo "outside" > "$repo/extra/thing"
printf 'abc\n' > "$repo/cad-runtime/bytes"
git -C "$repo" add -A
git -C "$repo" commit -qm base

key() {
  local out
  out="$("$repo/scripts/ci/cad-runtime-key.sh" "$@")"
  [[ "$out" =~ ^key=[0-9a-f]{64}$ ]] || fail "the key script printed '$out'"
  echo "${out#key=}"
}
scope() { "$repo/scripts/ci/cad-runtime-scope.sh" pull_request "$1" "$2" 2> /dev/null; }
# Stage everything, then back to the base commit after the check.
stage() { git -C "$repo" add -A; }
reset() { git -C "$repo" reset -q --hard && git -C "$repo" clean -qfd; }

base="$(key)"
[[ "$(key)" == "$base" ]] || fail "the same inputs gave two keys"

# Content: one flipped byte under cad-runtime/.
printf 'b' | dd of="$repo/cad-runtime/bytes" bs=1 seek=2 conv=notrunc status=none
[[ "$(cat "$repo/cad-runtime/bytes")" == abb ]] || fail "the byte flip did not land"
stage
[[ "$(key)" != "$base" ]] || fail "a flipped byte under cad-runtime/ kept the key"
reset

# Mode, an added file, and a deleted file under listed paths.
chmod +x "$repo/cad-runtime/bytes"
stage
[[ "$(git -C "$repo" ls-files -s cad-runtime/bytes)" == 100755* ]] || fail "the mode change was not staged"
[[ "$(key)" != "$base" ]] || fail "a mode change under cad-runtime/ kept the key"
reset
echo "new" > "$repo/cad-host/added.rs"
stage
[[ "$(key)" != "$base" ]] || fail "an added file under cad-host/ kept the key"
reset
git -C "$repo" rm -q cad-runtime/bytes
[[ "$(key)" != "$base" ]] || fail "a deleted file under cad-runtime/ kept the key"
reset

# The list, the key script, and the workflow are inputs too.
echo "# edited" >> "$repo/scripts/ci/cad-runtime-paths.txt"
stage
[[ "$(key)" != "$base" ]] || fail "an edit to the path list kept the key"
reset
echo "# edited" >> "$repo/.github/workflows/cad-runtime.yml"
stage
[[ "$(key)" != "$base" ]] || fail "an edit to the workflow kept the key"
reset

# Outside the listed paths nothing moves the key, and the scope script agrees.
base_commit="$(git -C "$repo" rev-parse HEAD)"
echo "changed" >> "$repo/docs/ci-runners.md"
echo "changed" >> "$repo/extra/thing"
stage
git -C "$repo" commit -qm outside
[[ "$(key)" == "$base" ]] || fail "a change outside the listed paths moved the key"
[[ "$(scope "$base_commit" HEAD)" == relevant=false ]] || fail "the scope script saw a change outside the listed paths"

# One list for both scripts: once extra/ is on it, both see a change there.
echo "extra/" >> "$repo/scripts/ci/cad-runtime-paths.txt"
stage
git -C "$repo" commit -qm "list extra/"
listed_commit="$(git -C "$repo" rev-parse HEAD)" listed_key="$(key)"
echo "changed again" >> "$repo/extra/thing"
stage
git -C "$repo" commit -qm "change extra/"
[[ "$(key)" != "$listed_key" ]] || fail "the key script did not read extra/ from the list"
[[ "$(scope "$listed_commit" HEAD)" == relevant=true ]] || fail "the scope script did not read extra/ from the list"
git -C "$repo" reset -q --hard "$base_commit"
[[ "$(key)" == "$base" ]] || fail "the base key changed after returning to the base commit"

# A listed path that matches nothing is an error, not an empty contribution.
git -C "$repo" rm -rq cad-host
if "$repo/scripts/ci/cad-runtime-key.sh" > /dev/null 2>&1; then fail "the key script passed with cad-host/ gone"; fi
reset

# The record file names the run and the key.
[[ "$(key record 4242 "$record")" == "$base" ]] || fail "record printed a different key"
[[ "$(cat "$record")" == "run_id=4242"$'\n'"hash=$base" ]] || fail "the record is not run_id and hash"
if "$repo/scripts/ci/cad-runtime-key.sh" record 12ab "$record" > /dev/null 2>&1; then fail "record took a non-numeric run id"; fi

# lookup trusts an artifact only through its run. A stub curl answers the two API calls from files in $stub and
# refuses a request without the token on stdin, an unexpected artifact name, or a URL it has no answer for. With
# $stub/generate it writes every artifact page itself: `growing` reports a total 100 larger on each page, `big` serves
# 51 full pages; both put a record for run 11 among other artifacts.
stub="$work/stub" name="cad-runtime-pass-$base"
mkdir -p "$work/bin" "$stub"
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
[[ "$(cat)" == "Authorization: Bearer test-token" ]] || exit 22
url="${*: -1}"
case "$url" in
  "https://api.github.com/repos/o/r/actions/artifacts?name=$EXPECTED_NAME&per_page=100&page="*)
    answer="artifacts-${url##*page=}.json" ;;
  https://api.github.com/repos/o/r/actions/runs/*) answer="run-${url##*/}.json" ;;
  *) exit 22 ;;
esac
if [[ -f "$STUB/generate" && "$answer" == artifacts-* ]]; then
  n="${url##*page=}" mode="$(cat "$STUB/generate")"
  if [[ "$mode" == growing ]]; then total=$((n * 100 + 100)) record_page=2; else total=5100 record_page=1; fi
  (( n * 100 <= total )) || exit 22
  printf '{"total_count":%s,"artifacts":[' "$total"
  for i in {0..99}; do
    (( i == 0 )) || printf ,
    artifact_name=other run_id=$((900000 + n * 100 + i))
    if (( n == record_page && i == 0 )); then artifact_name="$EXPECTED_NAME" run_id=11; fi
    printf '{"id":%s,"name":"%s","workflow_run":{"id":%s}}' $((n * 1000 + i)) "$artifact_name" "$run_id"
  done
  echo ']}'
  exit 0
fi
[[ -f "$STUB/$answer" ]] || exit 22
cat "$STUB/$answer"
STUB
chmod +x "$work/bin/curl"
page() { # <page> <total_count> <name>:<run id> ...; artifact ids are <page>000 plus the position
  local number="$1" total="$2" pair list=()
  shift 2
  for pair in "$@"; do
    list+=("{\"id\":$((number * 1000 + ${#list[@]})),\"name\":\"${pair%%:*}\",\"workflow_run\":{\"id\":${pair##*:}}}")
  done
  local IFS=,
  echo "{\"total_count\":$total,\"artifacts\":[${list[*]}]}" > "$stub/artifacts-$number.json"
}
artifacts() { page 1 "$#" "$@"; } # one page holding every <name>:<run id>
run() { # <id> [jq edit applied to a passed same-repo pull_request run]
  jq -n --argjson id "$1" '{id: $id, path: ".github/workflows/cad-runtime.yml", status: "completed",
    conclusion: "success", event: "pull_request", repository: {full_name: "o/r"}, head_repository: {full_name: "o/r"},
    actor: {login: "someone"}, triggering_actor: {login: "someone"}}' | jq "${2:-.}" > "$stub/run-$1.json"
}
lookup() { PATH="$work/bin:$PATH" STUB="$stub" EXPECTED_NAME="$name" GH_TOKEN=test-token \
  "$repo/scripts/ci/cad-runtime-key.sh" lookup o/r 2> /dev/null; }
reset_stub() { rm -f "$stub"/*; }
other="cad-runtime-pass-$(printf '0%.0s' {1..64})"
others() { local id list=(); for id in $(seq "$1" "$2"); do list+=("$other:$id"); done; echo "${list[@]}"; }
hit() { [[ "$(lookup)" == "source_run=$1"$'\n'"key=$base" ]] || fail "$2"; }
no_hit() { if lookup > /dev/null; then fail "$1"; fi; }

artifacts "$name:11"; run 11
hit 11 "a passed same-repository run with this key's record was not a hit"
if PATH="$work/bin:$PATH" STUB="$stub" EXPECTED_NAME="$name" GH_TOKEN='' \
  "$repo/scripts/ci/cad-runtime-key.sh" lookup o/r > /dev/null 2>&1; then fail "a lookup without a token was a hit"; fi
run 11 '.conclusion = "failure"'; no_hit "a failed run's record was a hit"
run 11 '.conclusion = "cancelled"'; no_hit "a cancelled run's record was a hit"
run 11 '.status = "in_progress" | .conclusion = null'; no_hit "an unfinished run's record was a hit"
run 11 '.path = ".github/workflows/pullfrog.yml" | .event = "workflow_dispatch"'
no_hit "a record uploaded by another workflow was a hit"
run 11 '.head_repository.full_name = "fork/r"'; no_hit "a fork's record was a hit"
run 11 '.actor.login = "dependabot[bot]"'; no_hit "a record from a run Dependabot started was a hit"
run 11 '.triggering_actor.login = "dependabot[bot]"'; no_hit "a record from a run Dependabot triggered was a hit"
run 11 '.event = "pull_request_target"'; no_hit "a pull_request_target run's record was a hit"
run 11 '.id = 99'; no_hit "a run answer for another id was a hit"
run 11 'del(.actor)'; no_hit "a run without an actor was a hit"
run 11 'del(.triggering_actor)'; no_hit "a run without a triggering actor was a hit"
run 11 '.actor.login = ""'; no_hit "a run with an empty actor login was a hit"
run 11 '.triggering_actor.login = null'; no_hit "a run with a null triggering actor login was a hit"
run 11 '.actor.login = 42'; no_hit "a run with a numeric actor login was a hit"
run 11 '.triggering_actor.login = {}'; no_hit "a run with an object as triggering actor login was a hit"
run 11 '.conclusion = "success"'
artifacts "cad-runtime-pass-$(printf '0%.0s' {1..64}):11"; no_hit "an artifact for another key was a hit"
artifacts; no_hit "an empty artifact list was a hit"
echo '{"artifacts": nul' > "$stub/artifacts-1.json"; no_hit "an unreadable artifact list was a hit"
echo '{"artifacts":[{"id":1,"name":"'"$name"'","workflow_run":{"id":11}}]}' > "$stub/artifacts-1.json"
no_hit "an artifact list without total_count was a hit"
echo '{"total_count":"1","artifacts":[{"id":1,"name":"'"$name"'","workflow_run":{"id":11}}]}' > "$stub/artifacts-1.json"
no_hit "an artifact list with a string total_count was a hit"
# An empty list, the usual miss, says so.
echo '{"total_count":0,"artifacts":[]}' > "$stub/artifacts-1.json"
if reason="$(PATH="$work/bin:$PATH" STUB="$stub" EXPECTED_NAME="$name" GH_TOKEN=test-token \
  "$repo/scripts/ci/cad-runtime-key.sh" lookup o/r 2>&1 > /dev/null)"; then fail "an empty artifact list was a hit"; fi
[[ "$reason" == *"no artifact is named $name"* ]] || fail "an empty artifact list gave another reason: $reason"
# total_count must be an integer from 1 to 5000 before bash does any arithmetic with it: the lookup must refuse the
# value itself, not fail later on it.
for bad_total in 18446744073709551600 -1 1.5 0 '"1"' null; do
  echo '{"total_count":'"$bad_total"',"artifacts":[{"id":1,"name":"'"$name"'","workflow_run":{"id":11}}]}' \
    > "$stub/artifacts-1.json"
  if reason="$(PATH="$work/bin:$PATH" STUB="$stub" EXPECTED_NAME="$name" GH_TOKEN=test-token \
    "$repo/scripts/ci/cad-runtime-key.sh" lookup o/r 2>&1 > /dev/null)"; then
    fail "an artifact list with total_count $bad_total was a hit"
  fi
  [[ "$reason" == *"is not a list with a total_count from 1 to 5000"* ]] \
    || fail "total_count $bad_total was not refused by the range check: $reason"
done
rm -f "$stub/artifacts-1.json"; no_hit "a failed artifact list request was a hit"
artifacts "$name:11"; rm -f "$stub/run-11.json"; no_hit "a run that did not load was a hit"
reset_stub
artifacts "$name:11" "$name:12"; run 11; run 12 '.conclusion = "failure"'
hit 11 "a passed run behind a failed one with the same record was not a hit"
reset_stub; run 11
echo '{"total_count":2,"artifacts":[{"id":1,"name":"'"$name"'","workflow_run":null},{"id":2,"name":"'"$name"'","workflow_run":{"id":11}}]}' \
  > "$stub/artifacts-1.json"
hit 11 "an artifact without a workflow_run hid a passed run's record"

# Every candidate and every page counts: a passed run behind ten newer failed ones, and a record on page 2.
reset_stub
candidates=("$name:11")
for id in {101..110}; do candidates+=("$name:$id"); run "$id" '.conclusion = "failure"'; done
artifacts "${candidates[@]}"; run 11
hit 11 "a passed run behind ten failed ones was not a hit"
reset_stub
first=()
for id in {5000..5099}; do first+=("$other:$id"); done
page 1 101 "${first[@]}"; page 2 101 "$name:11"; run 11
hit 11 "a record on the second page of the artifact list was not a hit"
first=("$name:11")
for id in {5001..5099}; do first+=("$other:$id"); done
page 1 150 "${first[@]}"; rm -f "$stub/artifacts-2.json"
no_hit "a lookup whose second page failed was a hit"

# A total_count in another JSON notation is the same integer: 1 to 5000 finds the record, and 2e2 means two pages.
for notation in 1e3 1.0 5e3 5.0e3; do
  reset_stub; run 11; page 1 "$notation" "$name:11"
  hit 11 "an artifact list with total_count $notation did not find its record"
done
reset_stub; run 11
read -ra full <<< "$(others 5000 5099)"
read -ra rest <<< "$(others 6000 6098)"
page 1 2e2 "${full[@]}"; page 2 2.0e2 "$name:11" "${rest[@]}"
hit 11 "an artifact list with total_count 2e2 did not read exactly two pages"

# The pages end where the first page's total_count says, or at a short page, whichever comes first.
reset_stub; run 11
read -ra full <<< "$(others 5000 5099)"
read -ra rest <<< "$(others 6000 6098)"
page 1 200 "${full[@]}"; page 2 200 "$name:11" "${rest[@]}"
hit 11 "a lookup did not stop at the page count total_count gives"
reset_stub; run 11
read -ra half <<< "$(others 6000 6048)"
page 1 250 "${full[@]}"; page 2 250 "$name:11" "${half[@]}"
hit 11 "a lookup did not stop at a short page"
# A page that repeats earlier artifacts, a total that changes while the list is read, and a list of more than 50
# pages are each a miss, even with a passed record further on.
reset_stub; run 11
page 1 300 "${full[@]}"; cp "$stub/artifacts-1.json" "$stub/artifacts-2.json"; page 3 300 "$name:11"
no_hit "a page repeating earlier artifacts was not a miss"
reset_stub; run 11; echo growing > "$stub/generate"
if PATH="$work/bin:$PATH" STUB="$stub" EXPECTED_NAME="$name" GH_TOKEN=test-token \
  timeout 20 "$repo/scripts/ci/cad-runtime-key.sh" lookup o/r > /dev/null 2>&1; then
  fail "an artifact list whose total grew on every page was a hit"
elif (( $? == 124 )); then
  fail "an artifact list whose total grew on every page kept the lookup running"
fi
reset_stub; run 11; echo big > "$stub/generate"
no_hit "an artifact list of 51 pages was not a miss"

echo "cad-runtime key: ok"
