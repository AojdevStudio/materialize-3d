#!/usr/bin/env bash
# Installs the system libraries Tauri builds against, for the Linux and mobile CI jobs. Both jobs run on the same
# self-hosted host, often at once, so a plain apt-get fails when the other job holds the dpkg lock (#372).
# The runner keeps its packages between runs, so the usual run finds every package and never touches apt.
# Otherwise apt waits up to 10 minutes for the lock instead of failing at once.
set -euo pipefail

packages=(libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev xvfb)

if dpkg -s "${packages[@]}" >/dev/null 2>&1; then
  echo "Tauri system libraries already installed"
  exit 0
fi

lock=(-o DPkg::Lock::Timeout=600)
sudo apt-get "${lock[@]}" update
sudo apt-get "${lock[@]}" install -y --no-install-recommends "${packages[@]}"
