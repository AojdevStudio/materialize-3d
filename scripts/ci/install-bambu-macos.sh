#!/usr/bin/env bash
# Installs the validated Bambu Studio into the runner's tool cache from Bambu
# Lab's official DMG and exports BAMBU_STUDIO_CLI for later steps. Idempotent:
# a verified install is reused. Nothing is copied into /Applications.
set -euo pipefail

version=02.08.02.61
asset=Bambu_Studio_mac-v${version}-20260820225108.dmg
sha256=cf648a95858fb630e1353c4987038df60d6caab693f18411fb95fb809f2d6926
root="${RUNNER_TOOL_CACHE:?}/bambu-studio/${version}"
cli="${root}/BambuStudio.app/Contents/MacOS/BambuStudio"

if [[ ! -x "$cli" ]]; then
  rm -rf "$root" && mkdir -p "$root"
  dmg="${RUNNER_TEMP:?}/${asset}"
  curl -fsSL -o "$dmg" "https://github.com/bambulab/BambuStudio/releases/download/v${version}/${asset}"
  echo "${sha256}  ${dmg}" | shasum -a 256 -c -
  mount="$(mktemp -d "${RUNNER_TEMP}/bambu-dmg.XXXXXX")"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" >/dev/null
  ditto "$mount/BambuStudio.app" "$root/BambuStudio.app"
  hdiutil detach "$mount" >/dev/null
  rm -f "$dmg"
fi

# Read the whole help text first: grep -q exits at the first match, and the
# SIGPIPE that leaves Bambu Studio with would fail this step under pipefail.
help="$("$cli" --help 2>&1)"
grep -q "BambuStudio-${version}" <<<"$help"
echo "BAMBU_STUDIO_CLI=${cli}" >> "${GITHUB_ENV:?}"
