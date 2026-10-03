#!/usr/bin/env bash
# Checks that this Linux runner host can build the CAD runtime images, and names whatever is missing:
#   scripts/ci/check-image-host.sh
# The images need Docker reachable by this user, buildx (for --platform, named build contexts, and the tar
# exporter), the arm64 binfmt handler registered with the F flag so containers can run it (qemu-user-static), and
# room for two clean builds per architecture. docs/ci-runners.md lists the packages for dev-substrate.
set -uo pipefail
missing=()
docker info >/dev/null 2>&1 || missing+=("Docker is not running, or this user cannot reach it (add it to the docker group)")
docker buildx version >/dev/null 2>&1 || missing+=("docker buildx is missing (Ubuntu package docker-buildx)")
binfmt=/proc/sys/fs/binfmt_misc/qemu-aarch64
if [[ ! -r "$binfmt" ]] || ! grep -qx enabled "$binfmt" || ! grep -q '^flags: .*F' "$binfmt"; then
  missing+=("no enabled arm64 binfmt handler with the F flag at $binfmt (Ubuntu package qemu-user-static)")
fi
free_gb="$(df -P -BG "${GITHUB_WORKSPACE:-$PWD}" | awk 'NR == 2 { sub("G", "", $4); print $4 }')"
if [[ ! "$free_gb" =~ ^[0-9]+$ ]] || (( free_gb < 20 )); then
  missing+=("${free_gb:-unknown} GB free under ${GITHUB_WORKSPACE:-$PWD}; two clean builds per architecture need 20 GB")
fi
if (( ${#missing[@]} > 0 )); then
  printf 'check-image-host: %s\n' "${missing[@]}" >&2
  exit 1
fi
echo "check-image-host: Docker, buildx, arm64 binfmt, and ${free_gb} GB free"
