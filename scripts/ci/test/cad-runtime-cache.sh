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
echo '{"arch":"amd64","files":{}}' > "$repo/cad-runtime/pins-amd64.json"
if cache fetch amd64 "$work/seventh"; then fail "pins that name no files were accepted"; fi

echo "cad-runtime cache: ok"
