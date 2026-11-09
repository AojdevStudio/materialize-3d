#!/usr/bin/env bash
# Rebuilds src-tauri/icons from the brand files in the materialize-3d-meta repo.
#
#   scripts/build-icons.sh <path to materialize-3d-meta/brand/icon/2026-11-09-wireframe-cube>
#
# Run it on a Mac with Xcode 26 or newer. The brand folder holds
# the full render (mark-1024.png) and two simple drawings for small sizes
# (mark-small-32.svg and mark-small-16.svg), because the render's grid blurs
# at 32 px and below. It copies the two drawings to src/assets/brand, where the
# favicon and the sidebar logo load them. It writes five things in src-tauri/icons:
# - Every PNG from the render through `tauri icon`, except 32x32.png and
#   Square30x30Logo.png, which come from the 32 px drawing.
# - icon.icns, through iconutil. Its 16 px entry is the 16 px drawing, its
#   32 px entries are the 32 px drawing, and its 64 px and larger entries are
#   the render. The .icns is CFBundleIconFile, the fallback for macOS 13 to 15.
# - icon.ico, with PNG entries. Its 16 px entry is the 16 px drawing, its 24
#   and 32 px entries are the 32 px drawing, and its 48 px and larger entries
#   are the render.
# - AppIcon.icon, the Icon Composer document for macOS 26: one flat layer, the
#   render, over the tile color. It has no Liquid Glass layers, because those
#   need a vector redraw of the mark.
# - Assets.car, AppIcon.icon compiled by actool. The bundler copies it into the
#   app and sets CFBundleIconName, so macOS 26 draws the icon from it.
#   It is committed because the bundler's own .icon compile crashes actool
#   when Tauri runs under bun (tauri-apps/tauri#15315), and so hosts without
#   Xcode 26, such as the macos-15 CI runner, bundle the same file.
set -euo pipefail

die() { echo "build-icons: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || die "usage: $0 <brand/icon/2026-11-09-wireframe-cube dir>"
brand="$(cd "$1" && pwd)"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icons="$root/src-tauri/icons"
[[ "$(uname -s)" == Darwin ]] || die "run on a Mac: iconutil and actool are macOS tools"
actool_major="$(xcrun actool --version --output-format human-readable-text \
  | sed -n 's/.*short-bundle-version: \([0-9]*\).*/\1/p')"
[[ "${actool_major:-0}" -ge 26 ]] || die "actool 26 or newer is required (found '${actool_major:-none}')"
for f in mark-1024.png mark-small-32.svg mark-small-16.svg; do
  [[ -f "$brand/$f" ]] || die "missing $brand/$f"
done

work="$(mktemp -d "${TMPDIR:-/tmp}/m3d-icons.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# `tauri icon` with its log kept quiet unless it fails.
tauri_icon() {
  (cd "$root" && bunx tauri icon "$@") >"$work/tauri-icon.log" 2>&1 \
    || { cat "$work/tauri-icon.log" >&2; die "tauri icon $1 failed"; }
}

# The render at every default size, plus 48 px for the .ico. The simple
# drawings at 32 px and below. `tauri icon` renders an SVG itself.
tauri_icon "$brand/mark-1024.png" -o "$work/render"
tauri_icon "$brand/mark-1024.png" -p 48 -o "$work/render48"
tauri_icon "$brand/mark-small-32.svg" -p 24 -p 30 -p 32 -o "$work/small32"
tauri_icon "$brand/mark-small-16.svg" -p 16 -o "$work/small16"

# The PNGs. `tauri icon` also writes Android, iOS, and 64x64 files this desktop
# app does not use, so only the files the repo already tracks are kept.
for f in 128x128.png 128x128@2x.png icon.png StoreLogo.png \
  Square44x44Logo.png Square71x71Logo.png Square89x89Logo.png \
  Square107x107Logo.png Square142x142Logo.png Square150x150Logo.png \
  Square284x284Logo.png Square310x310Logo.png; do
  cp "$work/render/$f" "$icons/$f"
done
cp "$work/small32/32x32.png" "$icons/32x32.png"
cp "$work/small32/30x30.png" "$icons/Square30x30Logo.png"
cp "$brand/mark-small-32.svg" "$brand/mark-small-16.svg" "$root/src/assets/brand/"

# The .icns, from an iconset. 128x128@2x.png is 256 px and icon.png is 512 px.
set="$work/icon.iconset"
mkdir -p "$set"
cp "$work/small16/16x16.png" "$set/icon_16x16.png"
cp "$work/small32/32x32.png" "$set/icon_16x16@2x.png"
cp "$work/small32/32x32.png" "$set/icon_32x32.png"
cp "$work/render/64x64.png" "$set/icon_32x32@2x.png"
cp "$work/render/128x128.png" "$set/icon_128x128.png"
cp "$work/render/128x128@2x.png" "$set/icon_128x128@2x.png"
cp "$work/render/128x128@2x.png" "$set/icon_256x256.png"
cp "$work/render/icon.png" "$set/icon_256x256@2x.png"
cp "$work/render/icon.png" "$set/icon_512x512.png"
cp "$brand/mark-1024.png" "$set/icon_512x512@2x.png"
iconutil -c icns "$set" -o "$icons/icon.icns"

# The .ico, with the same sizes `tauri icon` puts in one. Each entry is the PNG
# itself: a 6-byte header, one 16-byte directory entry per image, then the
# images. A width of 256 is written as 0.
bun -e '
  const [out, ...files] = process.argv.slice(1)
  const pngs = await Promise.all(files.map((file) => Bun.file(file).bytes()))
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach((png, i) => {
    const width = Buffer.from(png).readUInt32BE(16)
    const entry = 6 + 16 * i
    head[entry] = head[entry + 1] = width % 256
    head.writeUInt16LE(1, entry + 4)
    head.writeUInt16LE(32, entry + 6)
    head.writeUInt32LE(png.length, entry + 8)
    head.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  await Bun.write(out, new Blob([head, ...pngs]))
' "$icons/icon.ico" "$work/small16/16x16.png" "$work/small32/24x24.png" "$work/small32/32x32.png" \
  "$work/render48/48x48.png" "$work/render/64x64.png" "$work/render/128x128@2x.png"

# The Icon Composer document: one group with one layer, the render, over the
# tile color. macOS masks the full canvas to its own shape, so the render's
# transparent corners take the tile color. The dark entry repeats the light
# color so dark mode keeps the concrete tile instead of a system dark fill.
# Translucency is off so the render keeps its colors. The color is read as
# sRGB because the key that would make it Display P3 is absent.
hex="$(sed -n 's/.*<rect[^>]*fill="#\([0-9A-Fa-f]\{6\}\)".*/\1/p' "$brand/mark-small-32.svg")"
[[ -n "$hex" ]] || die "no tile color in $brand/mark-small-32.svg"
tile="$(awk -v r=$((16#${hex:0:2})) -v g=$((16#${hex:2:2})) -v b=$((16#${hex:4:2})) \
  'BEGIN { printf "srgb:%.5f,%.5f,%.5f,1.00000", r / 255, g / 255, b / 255 }')"
doc="$icons/AppIcon.icon"
rm -rf "$doc"
mkdir -p "$doc/Assets"
cp "$brand/mark-1024.png" "$doc/Assets/mark.png"
cat > "$doc/icon.json" <<EOF
{
  "fill-specializations" : [
    {
      "value" : {
        "solid" : "$tile"
      }
    },
    {
      "appearance" : "dark",
      "value" : {
        "solid" : "$tile"
      }
    }
  ],
  "groups" : [
    {
      "layers" : [
        {
          "image-name" : "mark.png",
          "name" : "Mark"
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
