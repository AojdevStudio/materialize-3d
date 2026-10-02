#!/usr/bin/env bash
# Rebuilds src-tauri/icons from the brand files in the materialize-3d-meta repo.
#
#   scripts/build-icons.sh <path to materialize-3d-meta/brand/icon/macos>
#
# Run it on a Mac with Xcode 26 or newer. It writes three things:
# - Every PNG, icon.icns, and icon.ico from the flat icon-1024.png, through
#   `tauri icon`. The .icns is CFBundleIconFile, the fallback for macOS 13 to 15.
# - AppIcon.icon, the Icon Composer document for macOS 26: the hexagon and M
#   layers as drawn, over the cream and dark backgrounds as its light and dark
#   fill colors.
# - Assets.car, AppIcon.icon compiled by actool. The bundler copies it into the
#   app and sets CFBundleIconName, so macOS 26 draws the Liquid Glass icon.
#   It is committed because the bundler's own .icon compile crashes actool
#   when Tauri runs under bun (tauri-apps/tauri#15315), and so hosts without
#   Xcode 26, such as the macos-15 CI runner, bundle the same file.
set -euo pipefail

die() { echo "build-icons: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || die "usage: $0 <brand/icon/macos dir>"
brand="$(cd "$1" && pwd)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icons="$root/src-tauri/icons"
[[ "$(uname -s)" == Darwin ]] || die "run on a Mac: actool compiles Assets.car"
actool_major="$(xcrun actool --version --output-format human-readable-text \
  | sed -n 's/.*short-bundle-version: \([0-9]*\).*/\1/p')"
[[ "${actool_major:-0}" -ge 26 ]] || die "actool 26 or newer is required (found '${actool_major:-none}')"
for f in icon-1024.png layers/0-background-light.svg layers/0-background-dark.svg layers/1-hexagon.svg layers/2-m.svg; do
  [[ -f "$brand/$f" ]] || die "missing $brand/$f"
done

work="$(mktemp -d "${TMPDIR:-/tmp}/m3d-icons.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The flat set. `tauri icon` also writes Android, iOS, and 64x64 files this
# desktop app does not use, so only the files the repo already tracks are kept.
(cd "$root" && bunx tauri icon "$brand/icon-1024.png" -o "$work/flat") >"$work/tauri-icon.log" 2>&1 \
  || { cat "$work/tauri-icon.log" >&2; die "tauri icon failed"; }
for f in 32x32.png 128x128.png 128x128@2x.png icon.png icon.icns icon.ico StoreLogo.png \
  Square30x30Logo.png Square44x44Logo.png Square71x71Logo.png Square89x89Logo.png \
  Square107x107Logo.png Square142x142Logo.png Square150x150Logo.png \
  Square284x284Logo.png Square310x310Logo.png; do
  cp "$work/flat/$f" "$icons/$f"
done

# An SVG background's single fill color as an Icon Composer sRGB color.
fill_of() {
  local hex
  hex="$(sed -n 's/.*fill="#\([0-9A-Fa-f]\{6\}\)".*/\1/p' "$1")"
  [[ -n "$hex" ]] || die "no fill color in $1"
  awk -v r=$((16#${hex:0:2})) -v g=$((16#${hex:2:2})) -v b=$((16#${hex:4:2})) \
    'BEGIN { printf "srgb:%.5f,%.5f,%.5f,1.00000", r / 255, g / 255, b / 255 }'
}

# The Icon Composer document. Groups are listed top first. Translucency is off
# so the hexagon and the M keep their brand colors; untagged SVG colors are
# read as sRGB because the key that would make them Display P3 is absent.
light="$(fill_of "$brand/layers/0-background-light.svg")"
dark="$(fill_of "$brand/layers/0-background-dark.svg")"
doc="$icons/AppIcon.icon"
rm -rf "$doc"
mkdir -p "$doc/Assets"
cp "$brand/layers/1-hexagon.svg" "$doc/Assets/hexagon.svg"
cp "$brand/layers/2-m.svg" "$doc/Assets/m.svg"
cat > "$doc/icon.json" <<EOF
{
  "fill-specializations" : [
    {
      "value" : {
        "solid" : "$light"
      }
    },
    {
      "appearance" : "dark",
      "value" : {
        "solid" : "$dark"
      }
    }
  ],
  "groups" : [
    {
      "layers" : [
        {
          "image-name" : "m.svg",
          "name" : "M"
        }
      ],
      "shadow" : {
        "kind" : "neutral",
        "opacity" : 0.5
      },
      "translucency" : {
        "enabled" : false,
        "value" : 0.5
      }
    },
    {
      "layers" : [
        {
          "image-name" : "hexagon.svg",
          "name" : "Hexagon"
        }
      ],
      "shadow" : {
        "kind" : "neutral",
        "opacity" : 0.5
      },
      "translucency" : {
        "enabled" : false,
        "value" : 0.5
      }
    }
  ],
  "supported-platforms" : {
    "squares" : [
      "macOS"
    ]
  }
}
EOF

# The same actool call the Tauri bundler makes for a .icon, with the asset
# named AppIcon. stdin is closed off from actool's helper (tauri#15315).
mkdir -p "$work/car"
xcrun actool "$doc" --compile "$work/car" --output-format human-readable-text \
  --notices --warnings --errors --output-partial-info-plist "$work/car/partial.plist" \
  --app-icon AppIcon --include-all-app-icons --enable-on-demand-resources NO \
  --development-region en --target-device mac --minimum-deployment-target 26.0 \
  --platform macosx </dev/null >/dev/null
cp "$work/car/Assets.car" "$icons/Assets.car"
echo "build-icons: wrote $icons"
