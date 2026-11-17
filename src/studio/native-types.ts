// Written from the Rust types by `generated_types_match_the_window_copy` in src-tauri/src/studio/window.rs.
// Do not edit. To write it again, run `M3D_WRITE_TYPES=1 cargo test --lib generated_types` in src-tauri.
import type { Plate } from '../../sidecar/src/protocol'

export type BambuLastUsed = { 
/**
 * The printer and its nozzle size in mm, as the printer preset's name gives them: `Bambu Lab P2S` and `0.4`.
 */
printer: string, nozzle: string, machine: BambuPreset, process: BambuPreset | null, 
/**
 * The filament in the first slot.
 */
filament: BambuPreset | null, plate: Plate | null, };

export type BambuPreset = { name: string, system: string | null, };

export type NozzleChoice = { 
/**
 * The nozzle size in mm, as in `0.4`.
 */
nozzle: string, machine: string, processes: Array<string>, process: string, filaments: Array<string>, filament: string, };

export type PrintInfo = { 
/**
 * The printer model without the maker's name, as in `P2S`.
 */
printer?: string, 
/**
 * The filament presets the slice used, without the maker's name or the printer, as in `PETG Basic`.
 */
filaments: Array<string>, layerHeightMm?: number, printSeconds?: number, filamentGrams?: number, };

export type PrinterChoice = { 
/**
 * The printer model's name, as in `Bambu Lab P2S`.
 */
printer: string, 
/**
 * The plates it takes, in the order of Bambu's `BedType`.
 */
plates: Array<Plate>, defaultPlate: Plate, 
/**
 * One per printer preset of this model, smallest nozzle first.
 */
nozzles: Array<NozzleChoice>, };

export type ProjectFile = { 
/**
 * Path inside the project, `/`-separated.
 */
rel: string, size: number, modifiedMs: number, 
/**
 * What a 3MF says about its print. Other files have none.
 */
print?: PrintInfo, };

export type SlicerCheck = { "found": "ready", version: string, } | { "found": "none" } | { "found": "other", detail: string, };

export type UpdateCheck = { "status": "upToDate", currentVersion: string, } | { "status": "available", currentVersion: string, version: string, notes: string | null, date: string | null, };

export type UpdateProgress = { downloaded: number, total: number | null, };
