#!/usr/bin/env bash
# Builds the CAD runtime for one architecture on a Linux host with Docker and binfmt QEMU:
#   cad-runtime/build.sh [arm64|amd64]
# Outputs in cad-runtime/out/<arch>/: rootfs.img (read-only erofs root), job.img (empty ext4 job disk template),
# and for arm64 Image (uncompressed kernel) and hostile-initramfs.cpio (restriction-test guest). pins.json there
# records every output's sha256 and size plus the pinned inputs; the helper refuses to boot anything else.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arch="${1:-arm64}"
[[ "$arch" == arm64 || "$arch" == amd64 ]] || { echo "usage: $0 [arm64|amd64]" >&2; exit 2; }
out="$here/out/$arch"
mkdir -p "$out"
# shellcheck source=kernel/pins.env
source "$here/kernel/pins.env"
PYTHON_BASE=python:3.13-slim-trixie@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81
cache="${M3D_KERNEL_CACHE:-$HOME/.cache/m3d-tool-cache/kernel}"
user=(--user "$(id -u):$(id -g)" -e HOME=/tmp)

docker build -q -t m3d-cad-tools --build-arg TOOLS_BASE="$TOOLS_BASE" -f "$here/image/tools.Dockerfile" "$here/image" >/dev/null

if [[ "$arch" == arm64 ]]; then
  # The kernel rebuilds only when its inputs change.
  stamp="$(cat "$here/kernel/pins.env" "$here/kernel/arm64.config" "$here/kernel/build-kernel.sh" | sha256sum | cut -d' ' -f1)"
  if [[ ! -f "$out/Image" || "$(cat "$out/kernel.stamp" 2>/dev/null)" != "$stamp" ]]; then
    tarball="$cache/linux-$KERNEL_VERSION.tar.xz"
    [[ -f "$tarball" ]] || { mkdir -p "$cache" && curl -fsSL -o "$tarball" "$KERNEL_URL"; }
    echo "$KERNEL_SHA256  $tarball" | sha256sum -c --quiet
    docker run --rm "${user[@]}" -v "$tarball:/src/linux.tar.xz:ro" -v "$here/kernel:/cfg:ro" -v "$out:/out" \
      m3d-cad-tools bash /cfg/build-kernel.sh
    echo "$stamp" > "$out/kernel.stamp"
  fi
  docker run --rm "${user[@]}" -v "$here/test:/src:ro" -v "$out:/out" m3d-cad-tools bash -c '
    set -e; mkdir -p /tmp/ir/proc
    aarch64-linux-gnu-gcc -static -Os -Wall -Werror -o /tmp/ir/init /src/hostile-guest.c
    cd /tmp/ir && find . | LC_ALL=C sort | cpio -o -H newc --reproducible --quiet > /out/hostile-initramfs.cpio'
fi

docker buildx build -q --platform "linux/$arch" --build-arg PYTHON_BASE="$PYTHON_BASE" \
  -f "$here/image/rootfs.Dockerfile" --output "type=tar,dest=$out/rootfs.tar" "$here" >/dev/null
docker run --rm "${user[@]}" -v "$out:/out" m3d-cad-tools bash -c '
  set -e
  rm -f /out/rootfs.img /out/job.img
  mkfs.erofs -zlz4hc,12 -T0 -U 6d336400-0000-4000-8000-0000000000e0 --tar=f /out/rootfs.img /out/rootfs.tar
  E2FSPROGS_FAKE_TIME=1 mkfs.ext4 -q -F -L m3djob -U 6d336400-0000-4000-8000-0000000000f0 \
    -E root_owner=0:0,lazy_itable_init=0,hash_seed=6d336400-0000-4000-8000-0000000000f1 -O ^has_journal /out/job.img 256M
  mkdir -p /tmp/t && tar -xf /out/rootfs.tar -C /tmp/t && du -sb /tmp/t | cut -f1 > /out/installed-bytes'
rm -f "$out/rootfs.tar"

python3 - "$out" "$arch" "$PYTHON_BASE" "$KERNEL_VERSION" "$KERNEL_SHA256" "$here/lock/requirements-$arch.txt" <<'PY'
import hashlib, json, os, sys
out, arch, base, kver, ksha, lock = sys.argv[1:]
def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return {"sha256": h.hexdigest(), "bytes": os.path.getsize(path)}
files = {n: digest(os.path.join(out, n)) for n in ("Image", "rootfs.img", "job.img", "hostile-initramfs.cpio") if os.path.exists(os.path.join(out, n))}
pins = {"arch": arch, "files": files,
        "rootfs_installed_bytes": int(open(os.path.join(out, "installed-bytes")).read()),
        "inputs": {"python_base": base, "kernel_version": kver, "kernel_sha256": ksha,
                   "lock_sha256": hashlib.sha256(open(lock, "rb").read()).hexdigest()}}
json.dump(pins, open(os.path.join(out, "pins.json"), "w"), indent=2)
print(json.dumps(pins, indent=2))
PY
