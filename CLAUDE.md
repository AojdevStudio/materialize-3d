# CLAUDE.md

Claude Code guidance for Materialize 3D. See AGENTS.md for the PR proof policy and recording setup — both apply.

## What This Is

Agentic 3D printing software — full AI control of Bambu Lab printers. Ideas to Atoms.

Test printer: Bambu Lab P2S on the developer's LAN.

## Project Structure

- packages/bambu-slicer/ — Headless slicing engine wrapping OrcaSlicer CLI

## Key Technical Context

- Two slicing paths exist. Sign packages are Bambu project 3MFs sliced by `src-tauri/src/fabrication/bambu`, which runs only Bambu Studio 02.08.02.61 with resolved P2S presets and verifies the G-code. The older STL path in `packages/bambu-slicer` and `src-tauri/src/slicer.rs` uses OrcaSlicer.
- On the OrcaSlicer STL path, machine profiles are auto-patched at slice time: Bambu Studio G-code templates are replaced with OrcaSlicer-compatible versions
- The development machine needs network access to the printer's VLAN.
- Developer Mode on P2S enables local MQTT for direct print control (loses Bambu Handy app)

## Running Tests

cd packages/bambu-slicer && bun test
