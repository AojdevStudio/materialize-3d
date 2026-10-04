#!/usr/bin/env bash
# A copy of the pinned CAD runtime on the Linux runner host, so the part-kind jobs have a runtime when the images job
# does not build one (its work is none or reuse):
#   scripts/ci/cad-runtime-cache.sh store <arm64|amd64> <dir>   copies the runtime in <dir> into the cache
#   scripts/ci/cad-runtime-cache.sh fetch <arm64|amd64> <dir>   fills <dir>, absent or empty, from the cache; on a miss
#                                                               it builds the runtime with cad-runtime/build.sh and
#                                                               stores it
# The cache is keyed by the sha256 of cad-runtime/pins-<arch>.json: $M3D_CAD_RUNTIME_CACHE (default
# ~/.cache/m3d-tool-cache/cad-runtime)/<arch>-<that sha256>/. Every file the pins name is checked, its size and its
# sha256, on the way in and again on the way out, and a symlink never counts. A cached runtime that no longer matches
# is a miss and is rebuilt, never used, and nothing that fails the check is stored. `fetch` also copies the committed
# pins into <dir> as pins.json. The tests that boot the runtime check it against the pins compiled into the app (and
# the helper) once more before any boot.
# The pins must name the requested architecture and only plain file names (one path segment, no "..", no "/"); any
# other pins are refused before anything is built, copied, or stored. A per-slot lock (flock) serializes the cache:
# a fetch copies out under the shared lock, and a store swaps a fully checked copy into place under the exclusive
# lock, so a fetch never sees a slot half replaced.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
die() { echo "cad-runtime cache: $*" >&2; exit 1; }
action="${1:-}" arch="${2:-}" dir="${3:-}"
[[ "$action" == store || "$action" == fetch ]] && [[ "$arch" == arm64 || "$arch" == amd64 ]] && [[ -n "$dir" ]] \
  || { echo "usage: $0 store|fetch arm64|amd64 <dir>" >&2; exit 2; }
pins="$root/cad-runtime/pins-$arch.json"
pins_sha="$(sha256sum "$pins")"
pins_sha="${pins_sha%% *}"
[[ "$pins_sha" =~ ^[0-9a-f]{64}$ ]] || die "could not hash $pins"
cache_root="${M3D_CAD_RUNTIME_CACHE:-$HOME/.cache/m3d-tool-cache/cad-runtime}"
slot="$cache_root/$arch-$pins_sha"
pinned_arch="$(jq -r '.arch' "$pins")"
[[ "$pinned_arch" == "$arch" ]] || die "$pins pins the architecture '$pinned_arch', not $arch"
names_text="$(jq -r '.files | keys[]' "$pins")"
mapfile -t names <<< "$names_text"
(( ${#names[@]} > 0 )) && [[ -n "${names[0]}" ]] || die "$pins names no files"
for name in "${names[@]}"; do
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$name" != *..* ]] || die "$pins names '$name', which is not a plain file name"
done

# matches <dir>: every pinned file is a regular file in <dir> with its pinned size and sha256.
matches() {
  local name want_bytes want_sha got
  for name in "${names[@]}"; do
    [[ -f "$1/$name" && ! -L "$1/$name" ]] || return 1
    want_bytes="$(jq -r --arg n "$name" '.files[$n].bytes' "$pins")"
    want_sha="$(jq -r --arg n "$name" '.files[$n].sha256' "$pins")"
    [[ "$(stat -c %s "$1/$name")" == "$want_bytes" ]] || return 1
    got="$(sha256sum "$1/$name")"
    [[ "${got%% *}" == "$want_sha" ]] || return 1
  done
}

# lock <shared|exclusive>: takes the slot's lock on a new descriptor, held until unlock or exit.
lock() {
  mkdir -p "$cache_root"
  exec {lock_fd}> "$cache_root/.lock-$arch-$pins_sha"
  flock "--$1" "$lock_fd"
}
unlock() { exec {lock_fd}>&-; }

# store_from <dir>: copies <dir>'s pinned files into a private staging directory beside the slot and checks them
# there, then, under the exclusive lock, moves the old slot aside and the checked copy into its place.
store_from() {
  local stage name old
  mkdir -p "$cache_root"
  stage="$(mktemp -d "$cache_root/.stage-$arch.XXXXXX")"
  for name in "${names[@]}"; do cp "$1/$name" "$stage/$name"; done
  if ! matches "$stage"; then
    rm -rf "$stage"
    die "the copy of $1 in the cache does not match $pins"
  fi
  old="$(mktemp -d "$cache_root/.old-$arch.XXXXXX")"
  lock exclusive
  if [[ -e "$slot" ]]; then mv "$slot" "$old/slot"; fi
  mv "$stage" "$slot"
  unlock
  rm -rf "$old"
}

case "$action" in
  store)
    matches "$dir" || die "$dir does not hold the runtime $pins pins"
    store_from "$dir"
    echo "cad-runtime cache: stored $arch under $pins_sha"
    ;;
  fetch)
    mkdir -p "$dir"
    [[ -z "$(ls -A "$dir")" ]] || die "$dir must be absent or empty"
    hit=false
    lock shared
    if matches "$slot"; then
      for name in "${names[@]}"; do cp "$slot/$name" "$dir/$name"; done
      hit=true
    fi
    unlock
    if [[ "$hit" == true ]]; then
      matches "$dir" || die "the runtime copied from the cache into $dir does not match $pins"
      echo "cad-runtime cache: $arch hit under $pins_sha"
    else
      echo "cad-runtime cache: $arch miss under $pins_sha; building it" >&2
      M3D_CAD_OUT="$dir" "$root/cad-runtime/build.sh" "$arch" > /dev/null
      matches "$dir" || die "the runtime built into $dir does not match $pins"
      store_from "$dir"
      echo "cad-runtime cache: $arch built and stored under $pins_sha"
    fi
    cp "$pins" "$dir/pins.json"
    ;;
esac
