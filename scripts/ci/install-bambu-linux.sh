#!/usr/bin/env bash
# Installs the validated Bambu Studio CLI into the runner's tool cache and
# exports BAMBU_STUDIO_CLI for later steps. Idempotent: a verified install is
# reused. The AppImage is extracted, so FUSE is not needed, but the CLI still
# loads these system libraries. Run apt-get update first on a fresh host.
set -euo pipefail

sudo apt-get install -y --no-install-recommends \
  libgstreamer-plugins-base1.0-0 libgstreamer-gl1.0-0 libegl1 libgl1 libgbm1 \
  libsecret-1-0 libmanette-0.2-0 libenchant-2-2 libhyphen0 libunwind8

version=02.08.02.61
asset=BambuStudio_ubuntu24.04-v${version}-20260820225108.AppImage
sha256=d501b103fac5424513ec0e8d6bc145fb30719de2c7d94d7320d723740c81a7fd
root="${RUNNER_TOOL_CACHE:?}/bambu-studio/${version}"
cli="${root}/squashfs-root/AppRun"

if [[ ! -x "$cli" ]]; then
  rm -rf "$root" && mkdir -p "$root" && cd "$root"
  curl -fsSL -o bambu.AppImage "https://github.com/bambulab/BambuStudio/releases/download/v${version}/${asset}"
  echo "${sha256}  bambu.AppImage" | sha256sum -c -
  chmod +x bambu.AppImage
  ./bambu.AppImage --appimage-extract >/dev/null
  rm bambu.AppImage
fi

# Read the whole help text first: grep -q exits at the first match, and the
# SIGPIPE that leaves Bambu Studio with would fail this step under pipefail.
help="$("$cli" --help 2>&1)"
grep -q "BambuStudio-${version}" <<<"$help"
echo "BAMBU_STUDIO_CLI=${cli}" >> "${GITHUB_ENV:?}"
