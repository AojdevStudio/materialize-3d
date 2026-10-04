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
# refuses a request without the token on stdin, an unexpected artifact name, or a URL it has no answer for.
stub="$work/stub" name="cad-runtime-pass-$base"
mkdir -p "$work/bin" "$stub"
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
[[ "$(cat)" == "Authorization: Bearer test-token" ]] || exit 22
url="${*: -1}"
case "$url" in
  "https://api.github.com/repos/o/r/actions/artifacts?name=$EXPECTED_NAME&per_page=100") answer=artifacts.json ;;
  https://api.github.com/repos/o/r/actions/runs/*) answer="run-${url##*/}.json" ;;
  *) exit 22 ;;
esac
[[ -f "$STUB/$answer" ]] || exit 22
cat "$STUB/$answer"
STUB
chmod +x "$work/bin/curl"
artifacts() { # <name>:<run id> ...
  local pair list=()
  for pair in "$@"; do list+=("{\"name\":\"${pair%%:*}\",\"workflow_run\":{\"id\":${pair##*:}}}"); done
  local IFS=,
  echo "{\"artifacts\":[${list[*]}]}" > "$stub/artifacts.json"
}
run() { # <id> [jq edit applied to a passed same-repo pull_request run]
  jq -n --argjson id "$1" '{id: $id, path: ".github/workflows/cad-runtime.yml", status: "completed",
    conclusion: "success", event: "pull_request", repository: {full_name: "o/r"}, head_repository: {full_name: "o/r"},
    actor: {login: "someone"}, triggering_actor: {login: "someone"}}' | jq "${2:-.}" > "$stub/run-$1.json"
}
lookup() { PATH="$work/bin:$PATH" STUB="$stub" EXPECTED_NAME="$name" GH_TOKEN=test-token \
  "$repo/scripts/ci/cad-runtime-key.sh" lookup o/r 2> /dev/null; }
reset_stub() { rm -f "$stub"/*.json; }
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
run 11 '.conclusion = "success"'
artifacts "cad-runtime-pass-$(printf '0%.0s' {1..64}):11"; no_hit "an artifact for another key was a hit"
artifacts; no_hit "an empty artifact list was a hit"
echo '{"artifacts": nul' > "$stub/artifacts.json"; no_hit "an unreadable artifact list was a hit"
rm -f "$stub/artifacts.json"; no_hit "a failed artifact list request was a hit"
artifacts "$name:11"; rm -f "$stub/run-11.json"; no_hit "a run that did not load was a hit"
reset_stub
artifacts "$name:11" "$name:12"; run 11; run 12 '.conclusion = "failure"'
hit 11 "a passed run behind a failed one with the same record was not a hit"

echo "cad-runtime key: ok"
