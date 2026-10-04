#!/usr/bin/env bash
# The part-kind jobs' key and scope cover the runtime inputs and the app's inputs together, and the image key and scope
# still cover only the runtime inputs, so a change to the app runs the part-kind jobs and never rebuilds the images:
#   scripts/ci/test/cad-backend-scope.sh
# Every case runs in a scratch repository that holds copies of the two scripts and both path lists, plus a
# placeholder file under each listed path, so it never touches this checkout. The cad-runtime workflow runs it.
set -euo pipefail
ci="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "cad-backend scope test: FAIL $*" >&2; exit 1; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=cad-scope-test GIT_AUTHOR_EMAIL=cad-scope-test@invalid
export GIT_COMMITTER_NAME=cad-scope-test GIT_COMMITTER_EMAIL=cad-scope-test@invalid
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/m3d-cad-scope.XXXXXX")"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
git init -q "$repo"
mkdir -p "$repo/scripts/ci"
cp "$ci/cad-runtime-key.sh" "$ci/cad-runtime-scope.sh" "$ci/cad-runtime-paths.txt" "$ci/cad-backend-paths.txt" \
  "$repo/scripts/ci/"
while IFS= read -r path; do
  if [[ "$path" == */ ]]; then
    mkdir -p "$repo/$path"
    echo "placeholder for $path" > "$repo/${path}placeholder"
  elif [[ ! -e "$repo/$path" ]]; then
    mkdir -p "$(dirname "$repo/$path")"
    echo "placeholder for $path" > "$repo/$path"
  fi
done < <(grep -hEv '^[[:space:]]*(#|$)' "$ci/cad-runtime-paths.txt" "$ci/cad-backend-paths.txt")
for listed in src-tauri/src/placeholder src-tauri/tests/fixtures/placeholder src-tauri/Cargo.lock; do
  [[ -f "$repo/$listed" ]] || fail "the part-kind list no longer covers $listed"
done
mkdir -p "$repo/docs" "$repo/src"
echo "docs" > "$repo/docs/ci-runners.md"
echo "frontend" > "$repo/src/App.tsx"
git -C "$repo" add -A
git -C "$repo" commit -qm base
base_commit="$(git -C "$repo" rev-parse HEAD)"

key() {
  local out
  out="$("$repo/scripts/ci/cad-runtime-key.sh" "$@")"
  [[ "$out" =~ ^key=[0-9a-f]{64}$ ]] || fail "the key script printed '$out'"
  echo "${out#key=}"
}
scope() { "$repo/scripts/ci/cad-runtime-scope.sh" "$@" pull_request "$base_commit" HEAD 2> /dev/null; }
commit() { git -C "$repo" add -A && git -C "$repo" commit -qm "$1"; }
back() { git -C "$repo" reset -q --hard "$base_commit"; }

image="$(key)" part="$(key --backend)"
[[ "$image" != "$part" ]] || fail "the part-kind key is the image key"
[[ "$(key --backend)" == "$part" ]] || fail "the same inputs gave two part-kind keys"

# A change to the app alone: the part-kind jobs run, the images do not rebuild.
echo "// changed" >> "$repo/src-tauri/src/placeholder"
commit "app"
[[ "$(key)" == "$image" ]] || fail "a change to src-tauri/src/ moved the image key"
[[ "$(scope)" == relevant=false ]] || fail "a change to src-tauri/src/ made the images relevant"
[[ "$(key --backend)" != "$part" ]] || fail "a change to src-tauri/src/ kept the part-kind key"
[[ "$(scope --backend)" == relevant=true ]] || fail "a change to src-tauri/src/ did not make the part-kind jobs relevant"
back

# A test fixture and the part-kind list itself count for the part-kind jobs only.
echo "changed" >> "$repo/src-tauri/tests/fixtures/placeholder"
commit "fixture"
[[ "$(key)" == "$image" && "$(scope)" == relevant=false ]] || fail "a fixture change reached the images"
[[ "$(key --backend)" != "$part" && "$(scope --backend)" == relevant=true ]] || fail "a fixture change missed the part-kind jobs"
back
echo "# edited" >> "$repo/scripts/ci/cad-backend-paths.txt"
commit "list"
[[ "$(key)" == "$image" ]] || fail "an edit to the part-kind list moved the image key"
[[ "$(key --backend)" != "$part" ]] || fail "an edit to the part-kind list kept the part-kind key"
back

# A runtime change runs both.
echo "changed" >> "$repo/cad-runtime/placeholder"
commit "runtime"
[[ "$(key)" != "$image" && "$(scope)" == relevant=true ]] || fail "a runtime change missed the images"
[[ "$(key --backend)" != "$part" && "$(scope --backend)" == relevant=true ]] || fail "a runtime change missed the part-kind jobs"
back

# Outside both lists nothing runs.
echo "changed" >> "$repo/docs/ci-runners.md"
echo "changed" >> "$repo/src/App.tsx"
commit "outside"
[[ "$(key)" == "$image" && "$(key --backend)" == "$part" ]] || fail "a change outside both lists moved a key"
[[ "$(scope)" == relevant=false && "$(scope --backend)" == relevant=false ]] || fail "a change outside both lists was relevant"
back

# Pushes and manual runs always do the full work.
[[ "$("$repo/scripts/ci/cad-runtime-scope.sh" --backend push 2> /dev/null)" == relevant=true ]] \
  || fail "a push did not make the part-kind jobs relevant"

# A part-kind record is looked up under its own name, so an image record never stands in for one. A stub curl answers
# only the artifact name the lookup is expected to ask for.
mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
[[ "$(cat)" == "Authorization: Bearer test-token" ]] || exit 22
url="${*: -1}"
case "$url" in
  "https://api.github.com/repos/o/r/actions/artifacts?name=$EXPECTED_NAME&per_page=100&page=1")
    printf '{"total_count":1,"artifacts":[{"id":1,"name":"%s","workflow_run":{"id":11}}]}\n' "$EXPECTED_NAME" ;;
  https://api.github.com/repos/o/r/actions/runs/11)
    echo '{"id":11,"path":".github/workflows/cad-runtime.yml","status":"completed","conclusion":"success",
      "event":"pull_request","repository":{"full_name":"o/r"},"head_repository":{"full_name":"o/r"},
      "actor":{"login":"someone"},"triggering_actor":{"login":"someone"}}' ;;
  *) exit 22 ;;
esac
STUB
chmod +x "$work/bin/curl"
lookup() { # <expected artifact name> [--backend]
  PATH="$work/bin:$PATH" EXPECTED_NAME="$1" GH_TOKEN=test-token \
    "$repo/scripts/ci/cad-runtime-key.sh" "${@:2}" lookup o/r 2> /dev/null
}
[[ "$(lookup "cad-backend-pass-$part" --backend)" == "source_run=11"$'\n'"key=$part" ]] \
  || fail "a passed part-kind record was not a hit"
if lookup "cad-runtime-pass-$part" --backend > /dev/null; then fail "a part-kind lookup asked for an image record"; fi
if lookup "cad-backend-pass-$image" > /dev/null; then fail "an image lookup asked for a part-kind record"; fi
[[ "$(lookup "cad-runtime-pass-$image")" == "source_run=11"$'\n'"key=$image" ]] || fail "the image lookup changed"

echo "cad-backend scope: ok"
