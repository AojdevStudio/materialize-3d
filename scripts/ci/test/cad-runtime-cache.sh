#!/usr/bin/env bash
# The runner host's runtime cache hands out only files that match the committed pins, rebuilds instead of using a
# changed copy, and stores only what matches:
#   scripts/ci/test/cad-runtime-cache.sh
# Every case runs in a scratch repository with made-up pins and a stub cad-runtime/build.sh that counts its runs, and
# a scratch cache directory, so it never touches this checkout or the host's real cache.
set -euo pipefail
ci="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "cad-runtime cache test: FAIL $*" >&2; exit 1; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/m3d-cad-cache.XXXXXX")"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
git init -q "$repo"
mkdir -p "$repo/scripts/ci" "$repo/cad-runtime"
cp "$ci/cad-runtime-cache.sh" "$repo/scripts/ci/"
export M3D_CAD_RUNTIME_CACHE="$work/cache" BUILDS="$work/builds"
printf 'kernel' > "$work/vmlinux" && printf 'root' > "$work/rootfs.img"
pin() { printf '"%s":{"sha256":"%s","bytes":%s}' "$1" "$(sha256sum "$work/$1" | cut -d' ' -f1)" "$(stat -c %s "$work/$1")"; }
echo "{\"arch\":\"amd64\",\"files\":{$(pin vmlinux),$(pin rootfs.img)}}" > "$repo/cad-runtime/pins-amd64.json"
# The stub builds the pinned files, or with $work/bad the wrong ones.
cat > "$repo/cad-runtime/build.sh" <<STUB
#!/usr/bin/env bash
echo build >> "\$BUILDS"
cp "$work/vmlinux" "$work/rootfs.img" "\$M3D_CAD_OUT/"
[[ ! -f "$work/bad" ]] || printf 'ROOT' > "\$M3D_CAD_OUT/rootfs.img"
STUB
chmod +x "$repo/cad-runtime/build.sh"
cache() { "$repo/scripts/ci/cad-runtime-cache.sh" "$@" 2> /dev/null; }
builds() { [[ -f "$BUILDS" ]] && wc -l < "$BUILDS" || echo 0; }
pinned() { cmp -s "$1/vmlinux" "$work/vmlinux" && cmp -s "$1/rootfs.img" "$work/rootfs.img" \
  && cmp -s "$1/pins.json" "$repo/cad-runtime/pins-amd64.json"; }

# A miss builds and stores; the next fetch is a hit and builds nothing.
cache fetch amd64 "$work/first" > /dev/null || fail "a miss did not build"
pinned "$work/first" || fail "a miss handed out something other than the pinned runtime"
[[ "$(builds)" == 1 ]] || fail "a miss built $(builds) times"
[[ "$(cache fetch amd64 "$work/second")" == *"hit"* ]] || fail "the second fetch was not a hit"
pinned "$work/second" && [[ "$(builds)" == 1 ]] || fail "a hit rebuilt or handed out the wrong files"

# A cached file changed in place, a size change, and a symlink are each a miss that rebuilds.
slot="$(echo "$M3D_CAD_RUNTIME_CACHE"/amd64-*)"
printf 'ROOT' > "$slot/rootfs.img"
cache fetch amd64 "$work/third" > /dev/null || fail "a changed cache entry did not rebuild"
pinned "$work/third" && [[ "$(builds)" == 2 ]] || fail "a changed cache entry was used"
printf 'root, longer' > "$slot/rootfs.img"
cache fetch amd64 "$work/fourth" > /dev/null && pinned "$work/fourth" && [[ "$(builds)" == 3 ]] \
  || fail "a resized cache entry was used"
rm "$slot/vmlinux" && ln -s "$work/vmlinux" "$slot/vmlinux"
cache fetch amd64 "$work/fifth" > /dev/null && pinned "$work/fifth" && [[ "$(builds)" == 4 ]] \
  || fail "a symlinked cache entry was used"

# A build that does not match the pins fails the fetch and stores nothing.
rm -rf "$M3D_CAD_RUNTIME_CACHE" && touch "$work/bad"
if cache fetch amd64 "$work/sixth" > /dev/null; then fail "a build that misses the pins was handed out"; fi
[[ ! -d "$slot" ]] || fail "a build that misses the pins was stored"
rm "$work/bad"

# store takes only a matching runtime; fetch takes only an absent or empty directory; other pins use another slot.
mkdir -p "$work/wrong" && printf 'kernel' > "$work/wrong/vmlinux" && printf 'ROOT' > "$work/wrong/rootfs.img"
if cache store amd64 "$work/wrong"; then fail "store took a runtime that misses the pins"; fi
cache store amd64 "$work/first" > /dev/null || fail "store refused the pinned runtime"
mkdir -p "$work/full" && echo stale > "$work/full/stale"
if cache fetch amd64 "$work/full"; then fail "fetch wrote into a directory that was not empty"; fi
good_pins="$(cat "$repo/cad-runtime/pins-amd64.json")"
echo '{"arch":"amd64","files":{}}' > "$repo/cad-runtime/pins-amd64.json"
if cache fetch amd64 "$work/seventh"; then fail "pins that name no files were accepted"; fi

# A pinned name is one plain file name. Pins that name a path, or that pin another architecture, are refused before
# anything is built, copied, or stored. Each case starts from an empty cache and a runtime directory that holds the
# named path with the pinned bytes, so only the name check can refuse it.
# refused <case> <name>: pins naming <name> make both store and fetch fail, with no build and nothing written.
refused() {
  local label="$1" name="$2" src="$work/named-$1" before after builds_before
  rm -rf "$M3D_CAD_RUNTIME_CACHE" "$work/outside" "$work/dest-$label" "$src"
  mkdir -p "$src/sub" "$src/$(dirname "$name")" "$M3D_CAD_RUNTIME_CACHE/amd64-slot"
  cp "$work/vmlinux" "$src/$name"
  printf '{"arch":"amd64","files":{"%s":{"sha256":"%s","bytes":%s}}}\n' "$name" \
    "$(sha256sum "$work/vmlinux" | cut -d' ' -f1)" "$(stat -c %s "$work/vmlinux")" > "$repo/cad-runtime/pins-amd64.json"
  before="$(cd "$work" && find . -path ./builds -prune -o -print | sort)" builds_before="$(builds)"
  if cache store amd64 "$src"; then fail "store accepted the pinned name $label"; fi
  if cache fetch amd64 "$work/dest-$label"; then fail "fetch accepted the pinned name $label"; fi
  rm -rf "$work/dest-$label"
  after="$(cd "$work" && find . -path ./builds -prune -o -print | sort)"
  [[ "$before" == "$after" ]] || fail "the pinned name $label wrote: $(comm -13 <(echo "$before") <(echo "$after") | tr '\n' ' ')"
  [[ "$(builds)" == "$builds_before" ]] || fail "the pinned name $label started a build"
}
refused parent ../outside
refused absolute "$work/abs/vmlinux"
refused nested sub/vmlinux
refused dotdot vm..linux
rm -rf "$M3D_CAD_RUNTIME_CACHE"
# Pins for another architecture under this architecture's file name.
builds_before="$(builds)"
echo "${good_pins//\"arch\":\"amd64\"/\"arch\":\"arm64\"}" > "$repo/cad-runtime/pins-amd64.json"
if cache store amd64 "$work/first"; then fail "store accepted pins whose arch is arm64"; fi
if cache fetch amd64 "$work/cross"; then fail "fetch accepted pins whose arch is arm64"; fi
[[ ! -e "$M3D_CAD_RUNTIME_CACHE" && ! -e "$work/cross" && "$(builds)" == "$builds_before" ]] \
  || fail "pins for another architecture wrote something or started a build"
echo "$good_pins" > "$repo/cad-runtime/pins-amd64.json"

# A key that holds a newline, a NUL, or another control character is refused as a whole, even when every line of it
# is a pinned name, and even beside the valid pins.
odd_key() {
  local label="$1" key="$2" before builds_before
  rm -rf "$M3D_CAD_RUNTIME_CACHE" "$work/dest-$label"
  jq --arg k "$key" '.files[$k] = .files.vmlinux' <<< "$good_pins" > "$repo/cad-runtime/pins-amd64.json"
  before="$(cd "$work" && find . -path ./builds -prune -o -print | sort)" builds_before="$(builds)"
  if cache store amd64 "$work/first"; then fail "store accepted a pinned key with $label"; fi
  if cache fetch amd64 "$work/dest-$label"; then fail "fetch accepted a pinned key with $label"; fi
  rm -rf "$work/dest-$label"
  [[ "$before" == "$(cd "$work" && find . -path ./builds -prune -o -print | sort)" ]] \
    || fail "a pinned key with $label wrote something"
  [[ "$(builds)" == "$builds_before" ]] || fail "a pinned key with $label started a build"
}
odd_key newline $'vmlinux\nrootfs.img'
odd_key tab $'vmlinux\trootfs.img'
# bash strings cannot hold a NUL, so this pins file is written as JSON text.
rm -rf "$M3D_CAD_RUNTIME_CACHE" "$work/dest-nul"
jq '.files["vm\u0000linux"] = .files.vmlinux' <<< "$good_pins" > "$repo/cad-runtime/pins-amd64.json"
builds_before="$(builds)"
if cache store amd64 "$work/first"; then fail "store accepted a pinned key with a NUL"; fi
if cache fetch amd64 "$work/dest-nul"; then fail "fetch accepted a pinned key with a NUL"; fi
[[ ! -e "$M3D_CAD_RUNTIME_CACHE" && ! -e "$work/dest-nul" && "$(builds)" == "$builds_before" ]] \
  || fail "a pinned key with a NUL wrote something or started a build"
echo "$good_pins" > "$repo/cad-runtime/pins-amd64.json"

# A store that fails or is killed between moving the old slot aside and moving the new copy in. The next fetch
# restores the old slot when it still matches the pins, or else rebuilds, and leaves no .old-* or .stage-* behind.
# A stub mv on PATH breaks only the move of the staged copy: M3D_TEST_MV=fail exits 73, =kill kills the store.
real_mv="$(command -v mv)"
mkdir -p "$work/fakebin"
cat > "$work/fakebin/mv" <<STUB
#!/usr/bin/env bash
if [[ "\$1" == */.stage-* ]]; then
  [[ "\$M3D_TEST_MV" == kill ]] && kill -9 "\$PPID"
  exit 73
fi
exec "$real_mv" "\$@"
STUB
chmod +x "$work/fakebin/mv"
leftovers() { find "$M3D_CAD_RUNTIME_CACHE" -maxdepth 1 \( -name '.old-*' -o -name '.stage-*' \) | wc -l; }
# interrupted <how> <cache before: full|empty> <fetch outcome: restored|rebuilt>
interrupted() {
  local how="$1" before="$2" outcome="$3" builds_before
  rm -rf "$M3D_CAD_RUNTIME_CACHE" "$work/after-$how-$before"
  if [[ "$before" == full ]]; then cache store amd64 "$work/first" > /dev/null || fail "setup store failed"; fi
  if (PATH="$work/fakebin:$PATH" M3D_TEST_MV="$how" cache store amd64 "$work/first") > /dev/null 2>&1; then
    fail "the store with a broken move ($how) succeeded"
  fi
  [[ ! -e "$(echo "$M3D_CAD_RUNTIME_CACHE"/amd64-*)" && "$(leftovers)" -gt 0 ]] \
    || fail "the broken move ($how, $before) did not leave the half-swapped state this case tests"
  builds_before="$(builds)"
  cache fetch amd64 "$work/after-$how-$before" > /dev/null || fail "the fetch after a $how store ($before) failed"
  pinned "$work/after-$how-$before" || fail "the fetch after a $how store ($before) handed out a wrong runtime"
  if [[ "$outcome" == restored ]]; then
    [[ "$(builds)" == "$builds_before" ]] || fail "the fetch after a $how store rebuilt instead of restoring"
  else
    [[ "$(builds)" == $((builds_before + 1)) ]] || fail "the fetch after a $how store on an empty cache did not rebuild"
  fi
  [[ "$(leftovers)" == 0 ]] || fail "the fetch after a $how store ($before) left .old-* or .stage-* directories"
  [[ -f "$(echo "$M3D_CAD_RUNTIME_CACHE"/amd64-*)/vmlinux" ]] || fail "the fetch after a $how store left no slot"
}
interrupted fail full restored
interrupted kill full restored
interrupted kill empty rebuilt
# A store after a killed store recovers the same way before it stages its own copy.
rm -rf "$M3D_CAD_RUNTIME_CACHE"
cache store amd64 "$work/first" > /dev/null
if (PATH="$work/fakebin:$PATH" M3D_TEST_MV=kill cache store amd64 "$work/first") > /dev/null 2>&1; then fail "the killed store succeeded"; fi
cache store amd64 "$work/first" > /dev/null || fail "a store after a killed store failed"
[[ "$(leftovers)" == 0 ]] || fail "a store after a killed store left .old-* or .stage-* directories"

# store and fetch at the same time: every fetch ends with the pinned runtime, from the cache or from a clean miss.
# Larger files widen the window in which a store replaces the slot while a fetch copies out of it.
head -c 8000000 /dev/urandom > "$work/vmlinux" && head -c 8000000 /dev/urandom > "$work/rootfs.img"
echo "{\"arch\":\"amd64\",\"files\":{$(pin vmlinux),$(pin rootfs.img)}}" > "$repo/cad-runtime/pins-amd64.json"
rm -rf "$M3D_CAD_RUNTIME_CACHE" "$work/race" && mkdir -p "$work/race"
cache fetch amd64 "$work/race/source" > /dev/null || fail "the race setup could not build"
touch "$work/race/storing"
( while [[ -f "$work/race/storing" ]]; do cache store amd64 "$work/race/source" > /dev/null || echo x >> "$work/race/store-failed"; done ) &
storer=$!
for i in $(seq 1 40); do
  if ! cache fetch amd64 "$work/race/$i" > /dev/null; then
    rm "$work/race/storing"; wait "$storer" || true
    fail "fetch $i failed while a store replaced the slot"
  fi
  pinned "$work/race/$i" || { rm "$work/race/storing"; wait "$storer" || true; fail "fetch $i handed out a wrong runtime"; }
  rm -rf "${work:?}/race/$i"
done
rm "$work/race/storing" && wait "$storer"
[[ ! -f "$work/race/store-failed" ]] || fail "a store failed while fetches read the slot"

echo "cad-runtime cache: ok"
