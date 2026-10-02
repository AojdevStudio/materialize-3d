# Bambu project settings templates

## p2s-0.4-pla-basic-x3.project_settings.json

Embedded as `Metadata/project_settings.config` in every sign package that
`fabrication::package::write_package` produces.

Provenance: Bambu Studio 02.08.02.61 (Linux AppImage), system profile bundle
version 02.08.00.05, written by the slicer's `--export-settings` option during a
successful verified CLI slice (return code 0, empty warning, three filaments)
with these presets loaded:

- machine: `Bambu Lab P2S 0.4 nozzle`
- process: `0.20mm Standard @BBL P2S`
- filaments: `Bambu PLA Basic @BBL P2S` in slots 1, 2 and 3

The file is vendored byte for byte from that export. It is the effective
configuration of the same presets the verification slice loads, so the handoff
package embeds the settings that were verified. The flush matrix
(`flush_volumes_matrix`) and every per-filament array are sized for exactly
three filaments.

Per sign, `write_package` overwrites `filament_colour` and
`filament_multi_colour` with the base color and ink colors (slot 1 base, slots
2 and 3 inks; an unused slot 3 gets a neutral gray). The colors stored in this
file are those of the run it was exported from and carry no meaning.

The export contains no printer serial, network address, account or host
identifiers, or file paths.
