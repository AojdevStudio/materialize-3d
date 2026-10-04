#!/usr/bin/env bash
# Every file the app crate compiles in or its tests read by a fixed path is covered by the part-kind key, the union of
# scripts/ci/cad-runtime-paths.txt and scripts/ci/cad-backend-paths.txt:
#   scripts/ci/test/cad-backend-inputs.sh
# It walks this checkout and collects:
#   - the literal path in every include_str!/include_bytes! in src-tauri's Rust, relative to that source file
#   - every literal joined to or concatenated with env!("CARGO_MANIFEST_DIR"), relative to src-tauri
#   - the icons and resources in src-tauri/tauri.conf.json's bundle, which tauri-build and generate_context! read
#   - tauri-build's own inputs: the manifest, the lock file, build.rs, tauri.conf.json, and capabilities/
# A path that is a file must be one the lists cover; a directory must have every tracked file under it covered. A
# path that names nothing tracked fails too, so a moved fixture is caught rather than skipped.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
cd "$root"
fail() { echo "cad-backend inputs test: FAIL $*" >&2; exit 1; }

specs_text="$(grep -hEv '^[[:space:]]*(#|$)' scripts/ci/cad-runtime-paths.txt scripts/ci/cad-backend-paths.txt)"
mapfile -t specs <<< "$specs_text"
declare -A covered=()
while IFS= read -r -d '' file; do covered["$file"]=1; done < <(git ls-files -z -- "${specs[@]}")

# Each found input as "<source>\t<repo-relative path>".
found="$(
  git ls-files -z -- 'src-tauri/*.rs' | while IFS= read -r -d '' rs; do
    perl -0777 -ne '
      my $dir = $ARGV =~ s{/[^/]*$}{}r;
      print "$ARGV\t$dir/$1\n" while /include_(?:str|bytes)!\s*\(\s*"([^"]+)"\s*\)/g;
      print "$ARGV\tsrc-tauri/$1\n" while /env!\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*\)?\s*(?:\.join\(|,)\s*"\/?([^"]+)"/g;
    ' "$rs"
  done
  jq -r '.bundle | (.icon // [])[], ((.resources // {}) | if type == "object" then keys[] else .[] end)
    | "src-tauri/tauri.conf.json\tsrc-tauri/\(.)"' src-tauri/tauri.conf.json
  for input in Cargo.toml Cargo.lock build.rs tauri.conf.json capabilities; do
    printf 'tauri-build\tsrc-tauri/%s\n' "$input"
  done
)"

checked=0 missing=()
while IFS=$'\t' read -r source path; do
  path="$(realpath -m --relative-to="$root" "$root/$path")"
  tracked_text="$(git ls-files -- ":(literal)$path")"
  [[ -n "$tracked_text" ]] || { missing+=("$path (from $source) names no tracked file"); continue; }
  mapfile -t tracked <<< "$tracked_text"
  for file in "${tracked[@]}"; do
    [[ -n "${covered[$file]:-}" ]] || missing+=("$file (from $source) is outside both lists")
  done
  checked=$((checked + 1))
done <<< "$found"

# The walk must still see the inputs this test was written against; an empty or broken walk proves nothing.
for known in cad-runtime/pins-amd64.json src-tauri/resources/fonts/Lato-Black.ttf docs/acceptance/p2s-test-sign.json \
  src-tauri/tests/fixtures/parts; do
  grep -q $'\t'"$known"'$' <<< "$(while IFS=$'\t' read -r s p; do printf '%s\t%s\n' "$s" \
    "$(realpath -m --relative-to="$root" "$root/$p")"; done <<< "$found")" || fail "the walk no longer finds $known"
done
if (( ${#missing[@]} > 0 )); then
  printf 'cad-backend inputs test: %s\n' "${missing[@]}" | sort -u >&2
  fail "${#missing[@]} part-kind input(s) outside scripts/ci/cad-runtime-paths.txt and scripts/ci/cad-backend-paths.txt"
fi
echo "cad-backend inputs: ok ($checked inputs)"
