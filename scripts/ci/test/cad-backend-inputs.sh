#!/usr/bin/env bash
# Every file the app crate compiles in or its tests read by a fixed path is covered by the part-kind key, the union of
# scripts/ci/cad-runtime-paths.txt and scripts/ci/cad-backend-paths.txt:
#   scripts/ci/test/cad-backend-inputs.sh
# It walks this checkout and collects:
#   - the literal path in every include_str!/include_bytes! in src-tauri's Rust, relative to that source file
#   - the literal in every Path::new(env!("CARGO_MANIFEST_DIR")).join("..."), relative to src-tauri
#   - every concat!(env!("CARGO_MANIFEST_DIR"), "...", ...), with all of its literals joined, relative to src-tauri
#   - the icons and resources in src-tauri/tauri.conf.json's bundle, which tauri-build and generate_context! read
#   - tauri-build's own inputs: the manifest, the lock file, build.rs, tauri.conf.json, and capabilities/
# A path that is a file must be one the lists cover; a directory must have every tracked file under it covered. A
# path that names nothing tracked fails too, so a moved fixture is caught rather than skipped.
# This is a static check. It sees compile-time includes and literal paths only, and it cannot see a path the code
# builds at run time. That is why the part-kind list holds all of src-tauri/, and this walk matters only for the
# inputs it finds outside src-tauri/. A scratch case first proves that the walk finds each form above.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
cd "$root"
fail() { echo "cad-backend inputs test: FAIL $*" >&2; exit 1; }

specs_text="$(grep -hEv '^[[:space:]]*(#|$)' scripts/ci/cad-runtime-paths.txt scripts/ci/cad-backend-paths.txt)"
mapfile -t specs <<< "$specs_text"
declare -A covered=()
while IFS= read -r -d '' file; do covered["$file"]=1; done < <(git ls-files -z -- "${specs[@]}")

# walk: prints each input of the git checkout in the current directory as "<source>\t<repo-relative path>".
walk() {
  local repo
  repo="$(pwd)"
  {
    git ls-files -z -- 'src-tauri/*.rs' | while IFS= read -r -d '' rs; do
      perl -0777 -ne '
        my $dir = $ARGV =~ s{/[^/]*$}{}r;
        print "$ARGV\t$dir/$1\n" while /include_(?:str|bytes)!\s*\(\s*"([^"]+)"\s*,?\s*\)/g;
        print "$ARGV\tsrc-tauri/$1\n"
          while /env!\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*\)\s*\.join\(\s*"([^"]+)"\s*\)/g;
        while (/concat!\(\s*env!\(\s*"CARGO_MANIFEST_DIR"\s*\)((?:\s*,\s*"[^"]*")+)\s*,?\s*\)/g) {
          my $tail = join "", $1 =~ /"([^"]*)"/g;
          print "$ARGV\tsrc-tauri$tail\n";
        }
      ' "$rs"
    done
    jq -r '.bundle | (.icon // [])[], ((.resources // {}) | if type == "object" then keys[] else .[] end)
      | "src-tauri/tauri.conf.json\tsrc-tauri/\(.)"' src-tauri/tauri.conf.json
    for input in Cargo.toml Cargo.lock build.rs tauri.conf.json capabilities; do
      printf 'tauri-build\tsrc-tauri/%s\n' "$input"
    done
  } | while IFS=$'\t' read -r source path; do
    printf '%s\t%s\n' "$source" "$(realpath -m --relative-to="$repo" "$repo/$path")"
  done
}

# The walk finds each form it claims to, in a scratch checkout.
scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/m3d-backend-inputs.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
git init -q "$scratch"
mkdir -p "$scratch/src-tauri/src/deep"
cat > "$scratch/src-tauri/src/deep/inputs.rs" <<'RUST'
const SPLIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/", "../README.md");
const ONE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/types/generated.ts");
const MULTILINE: &str = include_str!(
    "../../../docs/acceptance/sign.json"
);
static FONT: &[u8] = include_bytes!("../../resources/fonts/Lato-Black.ttf");
fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parts")
}
RUST
echo '{"bundle":{"icon":["icons/32x32.png"],"resources":{"../LICENSE":"LICENSE"}}}' > "$scratch/src-tauri/tauri.conf.json"
git -C "$scratch" add -A
scratch_found="$(cd "$scratch" && walk)"
for want in README.md src/types/generated.ts docs/acceptance/sign.json src-tauri/resources/fonts/Lato-Black.ttf \
  src-tauri/tests/fixtures/parts src-tauri/icons/32x32.png LICENSE src-tauri/capabilities; do
  grep -qx $'[^\t]*\t'"$want" <<< "$scratch_found" || fail "the walk missed $want in the scratch case"
done

found="$(walk)"

checked=0 missing=()
while IFS=$'\t' read -r source path; do
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
  grep -q $'\t'"$known"'$' <<< "$found" || fail "the walk no longer finds $known"
done
if (( ${#missing[@]} > 0 )); then
  printf 'cad-backend inputs test: %s\n' "${missing[@]}" | sort -u >&2
  fail "${#missing[@]} part-kind input(s) outside scripts/ci/cad-runtime-paths.txt and scripts/ci/cad-backend-paths.txt"
fi
echo "cad-backend inputs: ok ($checked inputs)"
