#!/usr/bin/env bash
# Compiles the sidecar (sidecar/src/main.ts) into the one binary Tauri bundles through
# bundle.externalBin. Tauri finds it by the name it ships with plus the Rust target triple,
# so the triple decides both the file name and the Bun target. tauri-build refuses to build
# the app crate, tests included, until the file exists, so run this before any cargo build.
# The triple is the one Tauri builds for, as its build commands pass it, else this machine's.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
triple="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
case "$triple" in
  aarch64-apple-darwin) target=bun-darwin-arm64 ;;
  x86_64-apple-darwin) target=bun-darwin-x64 ;;
  x86_64-unknown-linux-gnu) target=bun-linux-x64 ;;
  aarch64-unknown-linux-gnu) target=bun-linux-arm64 ;;
  *) echo "build-sidecar: no Bun target for $triple" >&2; exit 1 ;;
esac

cd "$root/sidecar"
bun install --frozen-lockfile
mkdir -p "$root/src-tauri/binaries"
bun build --compile --target="$target" src/main.ts --outfile "$root/src-tauri/binaries/materialize-sidecar-$triple"
