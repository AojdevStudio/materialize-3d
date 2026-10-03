#!/usr/bin/env bash
# Builds the CAD runtime for one architecture on a Linux host with Docker, buildx, and binfmt QEMU:
#   cad-runtime/build.sh [arm64|amd64]
# Outputs in cad-runtime/out/<arch>/ (or $M3D_CAD_OUT): rootfs.img (read-only erofs root), job.img (empty ext4 job
# disk template), the kernel (arm64: Image; amd64: vmlinux), and for arm64 hostile-initramfs.cpio (restriction-test
# guest). pins.json there records every output's sha256 and size plus the pinned inputs. The committed
# pins-<arch>.json is a copy of it; the helper compiles the arm64 pins in and refuses to boot anything else.
# M3D_CAD_NO_CACHE=1 builds both images without Docker's build cache, as reproduce.sh does.
# Network: wheels come from PyPI once per lock file into a host cache, Debian packages from snapshot.debian.org, and
# the kernel tarball from kernel.org into its own cache.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="${1:-arm64}"
[[ "$arch" == arm64 || "$arch" == amd64 ]] || { echo "usage: $0 [arm64|amd64]" >&2; exit 2; }
out="${M3D_CAD_OUT:-$here/out/$arch}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
# shellcheck source=kernel/pins.env
source "$here/kernel/pins.env"
PYTHON_BASE=python:3.13-slim-trixie@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81
# The snapshot both base images name in their own apt sources; packages added on top come from the same day.
DEBIAN_SNAPSHOT=20260918T000000Z
SOURCE_DATE_EPOCH="$(date -u -d "${DEBIAN_SNAPSHOT%%T*}" +%s)"
cache="${M3D_KERNEL_CACHE:-$HOME/.cache/m3d-tool-cache/kernel}"
wheels="${M3D_WHEEL_CACHE:-$HOME/.cache/m3d-tool-cache/wheels}/$arch"
user=(--user "$(id -u):$(id -g)" -e HOME=/tmp)
nocache=()
[[ "${M3D_CAD_NO_CACHE:-}" == 1 ]] && nocache=(--no-cache)

# Image builds write their full step output to a log beside the outputs. On failure the end of that log is
# printed, so the step that failed (pip, apt) shows its own error instead of buildx's one-line summary.
logged() { # <log name> <command...>
  local log="$out/$1"
  shift
  if ! "$@" > "$log" 2>&1; then
    echo "build.sh: $* failed; the last 60 lines of $log:" >&2
    tail -n 60 "$log" >&2
    exit 1
  fi
}

logged tools-build.log docker build --progress=plain "${nocache[@]}" --iidfile "$out/tools.iid" -t m3d-cad-tools \
  --build-arg TOOLS_BASE="$TOOLS_BASE" --build-arg DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" \
  -f "$here/image/tools.Dockerfile" "$here/image"
tools_image="$(cat "$out/tools.iid")"

# The kernel rebuilds only when an input that decides its bytes changes (kernel/stamp.sh lists them).
kernel=Image
[[ "$arch" == amd64 ]] && kernel=vmlinux
stamp="$("$here/kernel/stamp.sh" "$arch" "$DEBIAN_SNAPSHOT" "$tools_image")"
if [[ ! -f "$out/$kernel" || "$(cat "$out/kernel.stamp" 2>/dev/null)" != "$stamp" ]]; then
  tarball="$cache/linux-$KERNEL_VERSION.tar.xz" signature="$cache/linux-$KERNEL_VERSION.tar.sign"
  mkdir -p "$cache"
  [[ -f "$tarball" ]] || curl -fsSL -o "$tarball" "$KERNEL_URL"
  [[ -f "$signature" ]] || curl -fsSL -o "$signature" "$KERNEL_SIGN_URL"
  echo "$KERNEL_SHA256  $tarball" | sha256sum -c --quiet
  docker run --rm "${user[@]}" -v "$tarball:/src/linux.tar.xz:ro" -v "$signature:/src/linux.tar.sign:ro" \
    -v "$here/kernel:/cfg:ro" -v "$out:/out" m3d-cad-tools bash /cfg/build-kernel.sh "$arch"
  echo "$stamp" > "$out/kernel.stamp"
fi

if [[ "$arch" == arm64 ]]; then
  # cpio records owners and mtimes, so both are fixed before packing.
  docker run --rm "${user[@]}" -v "$here/test:/src:ro" -v "$out:/out" m3d-cad-tools bash -c '
    set -e; mkdir -p /tmp/ir/proc
    aarch64-linux-gnu-gcc -static -Os -Wall -Werror -o /tmp/ir/init /src/hostile-guest.c
    find /tmp/ir -exec touch -h -d @0 {} +
    cd /tmp/ir && find . | LC_ALL=C sort | cpio -o -H newc -R 0:0 --reproducible --quiet > /out/hostile-initramfs.cpio'
fi

# The wheels are fetched before the image build, once per lock file, and reused by every later build: pip checks
# each hash on download and again on install, so the cache cannot slip in a different file, and a build after the
# first needs no PyPI access. A fetch that cannot reach PyPI retries for minutes, then fails here with pip's error.
lock_sha256="$(sha256sum "$here/lock/requirements-$arch.txt" | cut -d' ' -f1)"
if [[ "$(cat "$wheels/.complete" 2>/dev/null)" != "$lock_sha256" ]]; then
  mkdir -p "$wheels"
  logged wheels-fetch.log docker run --rm --platform "linux/$arch" "${user[@]}" -v "$here/lock:/lock:ro" \
    -v "$wheels:/wheels" "$PYTHON_BASE" pip download --no-cache-dir --require-hashes --only-binary :all: --no-deps \
    --retries 10 --timeout 60 --dest /wheels -r "/lock/requirements-$arch.txt"
  echo "$lock_sha256" > "$wheels/.complete"
fi

logged rootfs-build.log docker buildx build --progress=plain "${nocache[@]}" --platform "linux/$arch" \
  --build-context wheels="$wheels" --build-arg PYTHON_BASE="$PYTHON_BASE" \
  --build-arg DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  -f "$here/image/rootfs.Dockerfile" --output "type=tar,dest=$out/rootfs.tar" "$here"
docker run --rm "${user[@]}" -v "$out:/out" m3d-cad-tools bash -c '
  set -e
  rm -f /out/rootfs.img /out/job.img
  mkfs.erofs --quiet -zlz4hc,12 -T0 -U 6d336400-0000-4000-8000-0000000000e0 --tar=f /out/rootfs.img /out/rootfs.tar
  E2FSPROGS_FAKE_TIME=1 mkfs.ext4 -q -F -L m3djob -U 6d336400-0000-4000-8000-0000000000f0 \
    -E root_owner=0:0,lazy_itable_init=0,hash_seed=6d336400-0000-4000-8000-0000000000f1 -O ^has_journal /out/job.img 256M
  mkdir -p /tmp/t && tar -xf /out/rootfs.tar -C /tmp/t && du -sb /tmp/t | cut -f1 > /out/installed-bytes'
rm -f "$out/rootfs.tar"

# pins.json is written inside the tools container, so the host needs no Python.
docker run --rm -i "${user[@]}" -v "$out:/out" -v "$here/lock:/lock:ro" m3d-cad-tools \
  python3 - /out "$arch" "$PYTHON_BASE" "$DEBIAN_SNAPSHOT" "$KERNEL_VERSION" "$KERNEL_SHA256" "$KERNEL_SIGNER" \
  "/lock/requirements-$arch.txt" <<'PY'
import hashlib, json, os, sys
out, arch, base, snapshot, kver, ksha, signer, lock = sys.argv[1:]
def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return {"sha256": h.hexdigest(), "bytes": os.path.getsize(path)}
names = ("Image", "vmlinux", "rootfs.img", "job.img", "hostile-initramfs.cpio")
files = {n: digest(os.path.join(out, n)) for n in names if os.path.exists(os.path.join(out, n))}
pins = {"arch": arch, "files": files,
        "rootfs_installed_bytes": int(open(os.path.join(out, "installed-bytes")).read()),
        "inputs": {"python_base": base, "debian_snapshot": snapshot, "kernel_version": kver, "kernel_sha256": ksha,
                   "kernel_signer": signer, "lock_sha256": hashlib.sha256(open(lock, "rb").read()).hexdigest()}}
json.dump(pins, open(os.path.join(out, "pins.json"), "w"), indent=2)
print(json.dumps(pins, indent=2))
PY
