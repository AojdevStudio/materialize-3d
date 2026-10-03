#!/usr/bin/env bash
# Builds the CAD runtime for one architecture on a Linux host with Docker, buildx, and binfmt QEMU:
#   cad-runtime/build.sh [arm64|amd64]
# Outputs in cad-runtime/out/<arch>/ (or $M3D_CAD_OUT): rootfs.img (read-only erofs root), job.img (empty ext4 job
# disk template), the kernel (arm64: Image; amd64: vmlinux), and for arm64 hostile-initramfs.cpio (restriction-test
# guest). pins.json there records every output's sha256 and size plus the pinned inputs. The committed
# pins-<arch>.json is a copy of it; the helper compiles the arm64 pins in and refuses to boot anything else.
# M3D_CAD_NO_CACHE=1 builds both images without Docker's build cache, as reproduce.sh does.
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
user=(--user "$(id -u):$(id -g)" -e HOME=/tmp)
nocache=()
[[ "${M3D_CAD_NO_CACHE:-}" == 1 ]] && nocache=(--no-cache)

docker build -q "${nocache[@]}" -t m3d-cad-tools --build-arg TOOLS_BASE="$TOOLS_BASE" \
  --build-arg DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" -f "$here/image/tools.Dockerfile" "$here/image" >/dev/null

# The kernel rebuilds only when its inputs change.
kernel=Image
[[ "$arch" == amd64 ]] && kernel=vmlinux
stamp="$(cat "$here/kernel/pins.env" "$here/kernel/$arch.config" "$here/kernel/build-kernel.sh" \
  "$here/kernel/kernel-signing-keys.asc" "$here/image/tools.Dockerfile" "$here/image/snapshot.sources" \
  | sha256sum | cut -d' ' -f1)"
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

docker buildx build -q "${nocache[@]}" --platform "linux/$arch" --build-arg PYTHON_BASE="$PYTHON_BASE" \
  --build-arg DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  -f "$here/image/rootfs.Dockerfile" --output "type=tar,dest=$out/rootfs.tar" "$here" >/dev/null
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
