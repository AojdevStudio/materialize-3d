#!/usr/bin/env bash
# Installs every system package the Linux and mobile CI jobs need. Both jobs run on the same self-hosted host, often
# at once, so a plain apt-get fails when the other job holds an apt lock (#372). Keep every CI apt call in this file.
# The runner keeps its packages between runs, so the usual run finds every package and never touches apt.
# Otherwise apt waits up to 10 minutes for the locks instead of failing at once.
set -euo pipefail

tauri=(libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev xvfb)
# The extracted Bambu Studio AppImage that scripts/ci/install-bambu-linux.sh sets up loads these.
bambu=(libgstreamer-plugins-base1.0-0 libgstreamer-gl1.0-0 libegl1 libgl1 libgbm1
  libsecret-1-0 libmanette-0.2-0 libenchant-2-2 libhyphen0 libunwind8)
packages=("${tauri[@]}" "${bambu[@]}")

# dpkg -s also exits 0 for a removed package that left its config files, so count the fully installed ones.
if [[ "$(dpkg -s "${packages[@]}" 2>/dev/null | grep -cx 'Status: install ok installed')" == "${#packages[@]}" ]]; then
  echo "CI system packages already installed"
  exit 0
fi

# DPkg::Lock::Timeout covers the dpkg lock only. apt-get update takes the package lists lock and fails at once when
# another apt holds it, so retry it until the same 10 minute deadline.
wait_s=600
deadline=$((SECONDS + wait_s))
until sudo apt-get update; do
  if ((SECONDS >= deadline)); then
    echo "apt-get update still failing after ${wait_s}s" >&2
    exit 1
  fi
  echo "apt-get update failed, another apt may hold the package lists lock; retrying in 10s"
  sleep 10
done
sudo apt-get -o DPkg::Lock::Timeout="$wait_s" install -y --no-install-recommends "${packages[@]}"
