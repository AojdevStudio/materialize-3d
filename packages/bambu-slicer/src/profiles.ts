import { readFileSync } from 'fs';
import { join } from 'path';

import { bambuProfileBase } from './platform';

const MACHINE_PRESET = 'Bambu Lab P2S 0.4 nozzle';

const PROCESS_MAP: Record<string, string> = {
  '0.08': '0.08mm High Quality @BBL P2S',
  '0.12': '0.12mm High Quality @BBL P2S',
  '0.16': '0.16mm Standard @BBL P2S',
  '0.20': '0.20mm Standard @BBL P2S',
  '0.24': '0.24mm Standard @BBL P2S',
};

const FILAMENT_MAP: Record<string, string> = {
  'Bambu PLA Basic': 'Bambu PLA Basic @BBL P2S',
  'Bambu PLA Matte': 'Bambu PLA Matte @BBL P2S',
  'Bambu PETG Basic': 'Bambu PETG Basic @BBL P2S 0.4 nozzle',
  'Generic PLA': 'Generic PLA @BBL P2S',
  'Generic PETG': 'Generic PETG @BBL P2S',
};

// Matches PROFILE_METADATA_KEYS in src-tauri/src/fabrication/bambu/presets.rs:
// these describe a preset, so an include never copies them into the includer.
const PROFILE_METADATA_KEYS = new Set([
  'alias',
  'description',
  'filament_id',
  'from',
  'include',
  'inherits',
  'instantiation',
  'name',
  'renamed_from',
  'setting_id',
  'type',
]);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type PresetConfig = { [key: string]: JsonValue };

type PresetKind = 'machine' | 'process' | 'filament';

/** Preset name to file path, per kind, from the vendor manifest `BBL.json`. */
type Manifest = Record<PresetKind, Map<string, string>>;

interface RawPreset {
  inherits: string | undefined;
  include: string[];
  own: PresetConfig;
}

export interface ProfileOptions {
  quality: string;
  filament: string;
  /** Bambu `system/BBL` profile dir. Defaults to the installed BambuStudio or OrcaSlicer one. */
  profileBase?: string;
}

export interface ResolvedProfiles {
  machine: PresetConfig;
  process: PresetConfig;
  filament: PresetConfig;
}

function isJsonObject(value: JsonValue): value is PresetConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readJsonObject(path: string): PresetConfig {
  const value = JSON.parse(readFileSync(path, 'utf-8')) as JsonValue;
  if (!isJsonObject(value)) throw new Error(`${path}: expected a JSON object`);
  return value;
}

function readManifest(profileBase: string): Manifest {
  const manifestPath = `${profileBase}.json`;
  const manifest = readJsonObject(manifestPath);
  const entries = (kind: PresetKind): Map<string, string> => {
    const list = manifest[`${kind}_list`];
    if (!Array.isArray(list)) throw new Error(`${manifestPath}: ${kind}_list must be an array`);
    return new Map(
      list.map((item) => {
        if (!isJsonObject(item) || typeof item.name !== 'string' || typeof item.sub_path !== 'string') {
          throw new Error(`${manifestPath}: ${kind}_list entries need a name and a sub_path`);
        }
        return [item.name, join(profileBase, item.sub_path)];
      }),
    );
  };
  return { machine: entries('machine'), process: entries('process'), filament: entries('filament') };
}

function readPreset(manifest: Manifest, kind: PresetKind, name: string): RawPreset {
  const path = manifest[kind].get(name);
  if (!path) throw new Error(`${kind} preset not found in BBL.json: "${name}"`);
  const { inherits, include = [], ...own } = readJsonObject(path);
  if (inherits !== undefined && typeof inherits !== 'string') {
    throw new Error(`${path}: inherits must be a string`);
  }
  const includes = typeof include === 'string' ? [include] : include;
  if (!isStringList(includes)) throw new Error(`${path}: include must be a string list`);
  return { inherits, include: includes, own };
}

/**
 * Flattens a preset the way the app's Rust resolver does: the parent's flattened
 * config, then each include's settings in order, then the preset's own keys.
 */
function flattenPreset(
  manifest: Manifest,
  kind: PresetKind,
  name: string,
  chain: readonly string[] = [],
): PresetConfig {
  const key = `${kind}:${name}`;
  if (chain.includes(key)) throw new Error(`preset cycle: ${[...chain, key].join(' -> ')}`);
  const nextChain = [...chain, key];
  const preset = readPreset(manifest, kind, name);

  const config = preset.inherits ? flattenPreset(manifest, kind, preset.inherits, nextChain) : {};
  for (const includeName of preset.include) {
    for (const [setting, value] of Object.entries(flattenPreset(manifest, kind, includeName, nextChain))) {
      if (!PROFILE_METADATA_KEYS.has(setting)) config[setting] = value;
    }
  }
  return { ...config, ...preset.own, name, type: kind, from: 'system' };
}

export function resolveProfiles(opts: ProfileOptions): ResolvedProfiles {
  const processPreset = PROCESS_MAP[opts.quality];
  if (!processPreset) {
    throw new Error(
      `Unknown quality "${opts.quality}". Valid: ${Object.keys(PROCESS_MAP).join(', ')}`
    );
  }

  const filamentPreset = FILAMENT_MAP[opts.filament];
  if (!filamentPreset) {
    throw new Error(
      `Unknown filament "${opts.filament}". Valid: ${Object.keys(FILAMENT_MAP).join(', ')}`
    );
  }

  const manifest = readManifest(opts.profileBase ?? bambuProfileBase());
  const machine = flattenPreset(manifest, 'machine', MACHINE_PRESET);
  if (!isStringList(machine.printable_area) || typeof machine.printable_height !== 'string') {
    throw new Error(`machine preset "${MACHINE_PRESET}" has no printable_area or printable_height`);
  }

  return {
    machine,
    process: flattenPreset(manifest, 'process', processPreset),
    filament: flattenPreset(manifest, 'filament', filamentPreset),
  };
}

export function listProfiles(): { qualities: string[]; filaments: string[] } {
  return {
    qualities: Object.keys(PROCESS_MAP),
    filaments: Object.keys(FILAMENT_MAP),
  };
}
