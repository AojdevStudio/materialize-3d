# CLAUDE.md

Claude Code guidance for Materialize 3D. See AGENTS.md for the PR proof policy and recording setup — both apply.

## What This Is

Agentic 3D printing software — full AI control of Bambu Lab printers. Ideas to Atoms.

Test printer: Bambu Lab P2S on the developer's LAN.

## Project Structure

- packages/bambu-slicer/ — Headless slicing engine wrapping OrcaSlicer CLI
- docs/printer/ — Hardware documentation for the test P2S

## Key Technical Context

- OrcaSlicer is used instead of BambuStudio CLI (BambuStudio segfaults on P2S 0.4mm nozzle profiles, GitHub #9636)
- Machine profiles are auto-patched at slice time: BambuStudio gcode templates replaced with OrcaSlicer-compatible versions
- The development machine needs network access to the printer's VLAN.
- Developer Mode on P2S enables local MQTT for direct print control (loses Bambu Handy app)

## Running Tests

cd packages/bambu-slicer && bun test
