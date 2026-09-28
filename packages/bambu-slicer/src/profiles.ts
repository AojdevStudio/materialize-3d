import { join } from 'path';

import { bambuProfileBase } from './platform';

// Per-platform Bambu system profile dir (BambuStudio store, OrcaSlicer fallback).
const BASE_PATH = bambuProfileBase();

const MACHINE_PROFILE = 'Bambu Lab P2S 0.4 nozzle.json';

const PROCESS_MAP: Record<string, string> = {
  '0.08': '0.08mm High Quality @BBL P2S.json',
  '0.12': '0.12mm High Quality @BBL P2S.json',
  '0.16': '0.16mm Standard @BBL P2S.json',
  '0.20': '0.20mm Standard @BBL P2S.json',
  '0.24': '0.24mm Standard @BBL P2S.json',
};

const FILAMENT_MAP: Record<string, string> = {
  'Bambu PLA Basic': 'Bambu PLA Basic @BBL P2S.json',
  'Bambu PLA Matte': 'Bambu PLA Matte @BBL P2S.json',
  'Bambu PETG Basic': 'Bambu PETG Basic @BBL P2S 0.4 nozzle.json',
  'Generic PLA': 'Generic PLA @BBL P2S.json',
  'Generic PETG': 'Generic PETG @BBL P2S.json',
};

export interface ProfileOptions {
  quality: string;
  filament: string;
}

export interface ResolvedProfiles {
  machine: string;
  process: string;
  filament: string;
}

export function resolveProfiles(opts: ProfileOptions): ResolvedProfiles {
  const processFile = PROCESS_MAP[opts.quality];
  if (!processFile) {
    throw new Error(
      `Unknown quality "${opts.quality}". Valid: ${Object.keys(PROCESS_MAP).join(', ')}`
    );
  }

  const filamentFile = FILAMENT_MAP[opts.filament];
  if (!filamentFile) {
    throw new Error(
      `Unknown filament "${opts.filament}". Valid: ${Object.keys(FILAMENT_MAP).join(', ')}`
    );
  }

  return {
    machine: join(BASE_PATH, 'machine', MACHINE_PROFILE),
    process: join(BASE_PATH, 'process', processFile),
    filament: join(BASE_PATH, 'filament', filamentFile),
  };
}

export function listProfiles(): { qualities: string[]; filaments: string[] } {
  return {
    qualities: Object.keys(PROCESS_MAP),
    filaments: Object.keys(FILAMENT_MAP),
  };
}
