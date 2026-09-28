/**
 * Cross-platform resolution of external tools and profile directories.
 *
 * Everything the slicer shells out to (OrcaSlicer) or reads from disk
 * (BambuStudio/OrcaSlicer system profiles) is located here so the rest of the
 * package stays platform-agnostic. Tools can be overridden with environment
 * variables, then standard per-OS install locations are probed, then PATH.
 */
import { existsSync } from 'fs';
import { join, delimiter } from 'path';
import { homedir } from 'os';

/** Search PATH for an executable (`.exe` appended on Windows). */
export function findOnPath(exeName: string): string | null {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  const names =
    process.platform === 'win32' ? [exeName, `${exeName}.exe`] : [exeName];
  for (const dir of pathEnv.split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Return the env override if set and pointing at an existing file. */
function envOverride(varName: string): string | null {
  const value = process.env[varName];
  return value && existsSync(value) ? value : null;
}

/** First existing path from a candidate list. */
function firstExisting(candidates: string[]): string | null {
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Environment variable that overrides OrcaSlicer CLI detection. */
export const ORCA_SLICER_CLI_ENV = 'ORCA_SLICER_CLI';

/** Primary OrcaSlicer CLI location for the current platform. */
export function expectedOrcaCli(): string {
  switch (process.platform) {
    case 'darwin':
      return '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer';
    case 'win32':
      return 'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe';
    default:
      return '/usr/bin/orca-slicer';
  }
}

/**
 * Locate the OrcaSlicer CLI binary.
 * Order: ORCA_SLICER_CLI env override → per-OS install paths → PATH.
 */
export function detectOrcaSlicer(): string | null {
  const override = envOverride(ORCA_SLICER_CLI_ENV);
  if (override) return override;

  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer']
      : process.platform === 'win32'
        ? ['C:\\Program Files\\OrcaSlicer\\orca-slicer.exe']
        : ['/usr/bin/orca-slicer', '/usr/local/bin/orca-slicer', '/snap/bin/orca-slicer'];

  return (
    firstExisting(candidates) ??
    findOnPath('orca-slicer') ??
    findOnPath('OrcaSlicer')
  );
}

/** Per-OS install hint for error messages. */
export function orcaInstallHint(): string {
  switch (process.platform) {
    case 'darwin':
      return 'brew install --cask orcaslicer';
    case 'win32':
      return 'download from https://github.com/SoftFever/OrcaSlicer/releases';
    default:
      return 'download the AppImage from https://github.com/SoftFever/OrcaSlicer/releases';
  }
}

/**
 * Base directory containing Bambu system profiles (`system/BBL`).
 * Prefers BambuStudio's profile store, falls back to OrcaSlicer's.
 */
export function bambuProfileBase(): string {
  const configBase =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support')
      : (process.env.APPDATA ?? join(homedir(), '.config'));

  for (const app of ['BambuStudio', 'OrcaSlicer']) {
    const candidate = join(configBase, app, 'system', 'BBL');
    if (existsSync(candidate)) return candidate;
  }
  // Default to the BambuStudio location even when missing, so error
  // messages point at a meaningful path.
  return join(configBase, 'BambuStudio', 'system', 'BBL');
}
