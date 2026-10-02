#!/usr/bin/env bash
# Does a STEP member inside the 3MF change how Bambu Studio slices it? Slices an app-built package as is and with
# the normalized STEP added at two paths, three times for the original (Bambu's G-code differs run to run), using
# the app's own slicer arguments (src-tauri/src/fabrication/bambu/slice.rs). Prints the facts to compare.
#   BAMBU_STUDIO_CLI=.../AppRun cad-host/spike/step-in-3mf.sh <package.3mf> <part.step> <workdir>
set -euo pipefail
: "${BAMBU_STUDIO_CLI:?}"
package="$(realpath "$1")" step="$(realpath "$2")" work="$3"
profiles="$(dirname "$BAMBU_STUDIO_CLI")/resources/profiles/BBL"
mkdir -p "$work" && cd "$work"
# Flatten a system preset's `inherits` chain (child keys win), as the app's resolver does before slicing.
flat() {
  local file="$profiles/$1/$2.json" parent
  parent="$(jq -r '.inherits // empty' "$file")"
  if [[ -n "$parent" ]]; then jq -s '.[0] * .[1] | del(.inherits)' <(flat "$1" "$parent") "$file"; else jq 'del(.inherits)' "$file"; fi
}
sha() { if command -v sha256sum > /dev/null; then sha256sum; else shasum -a 256; fi | cut -c1-12; }
settings() { unzip -p "$package" Metadata/project_settings.config | jq -r "$1"; }
flat machine "$(settings .printer_settings_id)" | jq '.from = "system"' > machine.json
flat process "$(settings .print_settings_id)" | jq '.from = "system"' > process.json
flat filament "$(settings '.filament_settings_id[0]')" | jq '.from = "system"' > filament.json
filaments="$(settings '.filament_settings_id | map("filament.json") | join(";")')"
for member in Metadata/part.step 3D/part.step; do
  variant="with-$(dirname "$member" | tr 'A-Z' 'a-z')-step.3mf"
  rm -rf stage && mkdir -p "stage/$(dirname "$member")" && cp "$step" "stage/$member"
  cp "$package" "$variant" && (cd stage && zip -q "../$variant" "$member")
done
cp "$package" original.3mf
for run in original-1:original.3mf original-2:original.3mf original-3:original.3mf \
           metadata-1:with-metadata-step.3mf metadata-2:with-metadata-step.3mf 3d-1:with-3d-step.3mf; do
  out="out-${run%%:*}" && rm -rf "$out" && mkdir "$out"
  (cd "$out" && "$BAMBU_STUDIO_CLI" "../${run#*:}" --load-settings "../process.json;../machine.json" \
     --load-filaments "${filaments//filament.json/../filament.json}" --check-preset --arrange 0 --slice 0 \
     --export-settings effective-settings.json --outputdir . > stdout.log 2> stderr.log) || true
  printf '%-12s result %s, warnings "%s", %s, %s, tool changes %s, settings %s, gcode %s\n' "${run%%:*}" \
    "$(jq -r .error_string "$out/result.json")" "$(jq -r '[.sliced_plates[].warning_message] | join("")' "$out/result.json")" \
    "$(grep -m1 'total layer number' "$out/plate_1.gcode" | sed 's/^; //')" \
    "$(grep -m1 'total filament weight' "$out/plate_1.gcode" | sed 's/^; //')" \
    "$(grep -cE '^T[0-9]+$' "$out/plate_1.gcode")" \
    "$(sha < "$out/effective-settings.json")" "$(sha < "$out/plate_1.gcode")"
done
