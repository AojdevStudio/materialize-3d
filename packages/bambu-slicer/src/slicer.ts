import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectOrcaSlicer, expectedOrcaCli, orcaInstallHint } from './platform';

// This legacy STL path slices with OrcaSlicer. It was chosen when Bambu Studio's
// CLI crashed on STL input with P2S 0.4 nozzle profiles (GitHub #9636). Sign
// packages are Bambu project 3MFs sliced by Bambu Studio 02.08.02.61 in the app's
// Rust fabrication module instead.
// Resolved per-platform (env override → install paths → PATH); see platform.ts.
const ORCA_CLI = detectOrcaSlicer() ?? expectedOrcaCli();

// Simplified gcode templates compatible with OrcaSlicer's parser.
// BambuStudio profiles use variables like `min_vitrification_temperature` that
// OrcaSlicer doesn't support. These simplified versions produce valid gcode
// for the P2S — the actual start/end gcode is embedded in the printer firmware.
const ORCA_MACHINE_START_GCODE =
  'G28\\nG1 Z5 F5000\\nM104 S[nozzle_temperature_initial_layer]\\nM140 S[bed_temperature_initial_layer_single]\\nM109 S[nozzle_temperature_initial_layer]\\nM190 S[bed_temperature_initial_layer_single]\\nG92 E0\\n';
const ORCA_MACHINE_END_GCODE =
  'G1 E-2 F2400\\nG28 X\\nM104 S0\\nM140 S0\\nM84\\n';
const ORCA_LAYER_CHANGE_GCODE =
  'G92 E0\\n;LAYER_CHANGE\\n;Z:[layer_z]\\nM73 L[layer_num]\\n';

export interface SliceInput {
  inputFiles: string[];
  outputFile: string;
  machine: string;
  process: string;
  filament: string;
}

export interface SliceResult {
  success: boolean;
  outputFile: string;
  error?: string;
}

export function buildSliceArgs(input: SliceInput): string[] {
  return [
    ...input.inputFiles,
    '--load-settings',
    `${input.machine};${input.process}`,
    '--load-filaments',
    input.filament,
    '--arrange',
    '1',
    '--orient',
    '1',
    '--slice',
    '0',
    '--export-3mf',
    input.outputFile,
  ];
}

/**
 * Patches a BambuStudio machine profile to be OrcaSlicer-compatible.
 * Merges template includes inline and replaces BambuStudio-specific gcode
 * with simplified versions that OrcaSlicer can parse.
 */
function patchMachineProfile(machineProfilePath: string): string {
  const profile = JSON.parse(readFileSync(machineProfilePath, 'utf-8'));
  const profileDir = machineProfilePath.replace(/\/[^/]+$/, '');

  // Inline template includes
  if (profile.include) {
    for (const inc of profile.include) {
      const tpath = join(profileDir, `${inc}.json`);
      if (existsSync(tpath)) {
        const template = JSON.parse(readFileSync(tpath, 'utf-8'));
        for (const [k, v] of Object.entries(template)) {
          if (!['name', 'instantiation', 'type', 'from'].includes(k)) {
            profile[k] = v;
          }
        }
      }
    }
    delete profile.include;
  }

  // Replace BambuStudio-specific gcode with OrcaSlicer-compatible versions
  profile.machine_start_gcode = ORCA_MACHINE_START_GCODE;
  profile.machine_end_gcode = ORCA_MACHINE_END_GCODE;
  profile.layer_change_gcode = ORCA_LAYER_CHANGE_GCODE;

  // Ensure nozzle_volume_type exists
  if (!profile.nozzle_volume_type) {
    profile.nozzle_volume_type = ['0'];
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'bambu-slicer-'));
  const patchedPath = join(tmpDir, 'machine-patched.json');
  writeFileSync(patchedPath, JSON.stringify(profile, null, 2));
  return patchedPath;
}

export async function runSlicer(input: SliceInput): Promise<SliceResult> {
  if (!existsSync(ORCA_CLI)) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `OrcaSlicer CLI not found at ${ORCA_CLI}. Install: ${orcaInstallHint()}`,
    };
  }

  for (const f of input.inputFiles) {
    if (!existsSync(f)) {
      return {
        success: false,
        outputFile: input.outputFile,
        error: `Input file not found: ${f}`,
      };
    }
  }

  // Patch machine profile for OrcaSlicer compatibility
  const patchedMachine = patchMachineProfile(input.machine);
  const patchedInput = { ...input, machine: patchedMachine };

  const args = buildSliceArgs(patchedInput);
  const proc = Bun.spawn([ORCA_CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `OrcaSlicer exited with code ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
    };
  }

  if (!existsSync(input.outputFile)) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `Slicing completed but output file not found at ${input.outputFile}\nstdout: ${stdout}\nstderr: ${stderr}`,
    };
  }

  return {
    success: true,
    outputFile: input.outputFile,
  };
}
