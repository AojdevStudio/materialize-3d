#!/usr/bin/env bash
# Builds one guest kernel inside the tools container (see ../build.sh): build-kernel.sh <arm64|amd64>
# In: /src/linux.tar.xz (sha256-checked by build.sh), /src/linux.tar.sign, and /cfg (this directory). Out:
# /out/kernel.config plus, for arm64, /out/Image (uncompressed, which VZLinuxBootLoader needs) or, for amd64,
# /out/vmlinux (an uncompressed ELF with a PVH entry point, which Firecracker and QEMU's microvm both boot).
set -euo pipefail
arch="$1"
# shellcheck source=pins.env
source /cfg/pins.env

# The sha256 pin proves this is the tarball that was pinned; the signature proves kernel.org's signer released it.
# kernel.org signs the uncompressed tar, so one signature covers every compression.
gpg --batch --quiet --dearmor < /cfg/kernel-signing-keys.asc > /tmp/kernel-keys.gpg
status="$(xz -cd /src/linux.tar.xz | gpgv --status-fd 1 --keyring /tmp/kernel-keys.gpg /src/linux.tar.sign - 2>/dev/null)" \
  || { echo "kernel: the tarball's signature does not verify" >&2; exit 1; }
grep -Eq "^\[GNUPG:\] VALIDSIG .* $KERNEL_SIGNER\$" <<<"$status" \
  || { echo "kernel: the tarball is not signed by $KERNEL_SIGNER" >&2; exit 1; }
echo "kernel: signature by $KERNEL_SIGNER verified" >&2

case "$arch" in
  arm64) export ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu-; target=Image; built=arch/arm64/boot/Image ;;
  amd64) export ARCH=x86_64; target=vmlinux; built=vmlinux ;;
  *) echo "usage: $0 <arm64|amd64>" >&2; exit 2 ;;
esac
work=/tmp/build/linux
mkdir -p "$work" && tar -xJf /src/linux.tar.xz -C "$work" --strip-components=1
cd "$work"
export KBUILD_BUILD_TIMESTAMP='1970-01-01' KBUILD_BUILD_USER=m3d KBUILD_BUILD_HOST=m3d
make -s KCONFIG_ALLCONFIG="/cfg/$arch.config" allnoconfig
# allnoconfig drops any requested symbol whose dependencies are unmet; fail loudly instead of booting a kernel
# that silently lacks a device driver.
missing=0
while IFS= read -r line; do
  [[ "$line" =~ ^(CONFIG_[A-Z0-9_]+)=(.*)$ ]] || continue
  sym="${BASH_REMATCH[1]}" want="${BASH_REMATCH[2]}"
  if [[ "$want" == n ]]; then
    grep -q "^$sym=" .config && { echo "kernel config: $sym should be off" >&2; missing=1; }
  else
    grep -q "^$sym=$want$" .config || { echo "kernel config: $sym=$want did not stick" >&2; missing=1; }
  fi
done < "/cfg/$arch.config"
[[ $missing == 0 ]] || exit 1
make -s -j"$(nproc)" "$target"
install -m 0644 "$built" "/out/$target"
install -m 0644 .config /out/kernel.config
