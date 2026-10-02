#!/usr/bin/env bash
# Builds the arm64 guest kernel inside the tools container (see ../build.sh).
# In: /src/linux.tar.xz (sha256-checked by build.sh), /cfg/arm64.config. Out: /out/Image (uncompressed, which is
# what VZLinuxBootLoader needs) and /out/kernel.config.
set -euo pipefail
work=/tmp/build/linux
mkdir -p "$work" && tar -xJf /src/linux.tar.xz -C "$work" --strip-components=1
cd "$work"
export ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- KBUILD_BUILD_TIMESTAMP='1970-01-01' KBUILD_BUILD_USER=m3d KBUILD_BUILD_HOST=m3d
make -s KCONFIG_ALLCONFIG=/cfg/arm64.config allnoconfig
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
done < /cfg/arm64.config
[[ $missing == 0 ]] || exit 1
make -s -j"$(nproc)" Image
install -m 0644 arch/arm64/boot/Image /out/Image
install -m 0644 .config /out/kernel.config
