import { existsSync, writeFileSync, mkdtempSync, renameSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { detectOrcaSlicer, expectedOrcaCli, orcaInstallHint } from './platform';
import type { PresetConfig, ResolvedProfiles } from './profiles';
import { readZipEntry } from './zip';

// This legacy STL path slices with OrcaSlicer. It was chosen when Bambu Studio's
// CLI crashed on STL input with P2S 0.4 nozzle profiles (GitHub #9636). Sign
// packages are Bambu project 3MFs sliced by Bambu Studio 02.08.02.61 in the app's
// Rust fabrication module instead.

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

interface SliceFiles {
  inputFiles: string[];
  outputFile: string;
}

export type SliceInput = SliceFiles & ResolvedProfiles;

export type SliceResult =
  | { success: true; outputFile: string }
  | { success: false; outputFile: string; error: string };

export function buildSliceArgs(
  input: SliceFiles & { machine: string; process: string; filament: string },
): string[] {
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

/** Counts the parts OrcaSlicer reports as sliced in the 3MF's `slice_info.config`. */
function countSlicedParts(outputFile: string): number {
  const sliceInfo = readZipEntry(outputFile, 'Metadata/slice_info.config').toString('utf-8');
  const objects = sliceInfo.match(/<object\b[^>]*>/g) ?? [];
  return objects.filter((tag) => !/\bskipped="true"/.test(tag)).length;
}

export async function runSlicer(input: SliceInput): Promise<SliceResult> {
  const orcaCli = detectOrcaSlicer() ?? expectedOrcaCli();
  if (!existsSync(orcaCli)) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `OrcaSlicer CLI not found at ${orcaCli}. Install: ${orcaInstallHint()}`,
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

  const machine = {
    ...input.machine,
    machine_start_gcode: ORCA_MACHINE_START_GCODE,
    machine_end_gcode: ORCA_MACHINE_END_GCODE,
    layer_change_gcode: ORCA_LAYER_CHANGE_GCODE,
    nozzle_volume_type: input.machine.nozzle_volume_type ?? ['0'],
  };
  const tmpDir = mkdtempSync(join(tmpdir(), 'bambu-slicer-'));
  const writePreset = (kind: keyof ResolvedProfiles, config: PresetConfig) => {
    const path = join(tmpDir, `${kind}.json`);
    writeFileSync(path, JSON.stringify(config, null, 2));
    return path;
  };

  // OrcaSlicer exports into a directory this run owns, beside the output, and the 3MF
  // moves into place only once it checks out. An earlier slice's 3MF at the output path
  // can't pass as this one, and a failed slice leaves it untouched.
  let stagingDir: string;
  try {
    stagingDir = mkdtempSync(join(dirname(input.outputFile), '.slice-'));
  } catch (e) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `Could not stage the slice beside ${input.outputFile}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  using _staging = { [Symbol.dispose]: () => rmSync(stagingDir, { recursive: true, force: true }) };
  const staged = join(stagingDir, 'out.3mf');

  const args = buildSliceArgs({
    inputFiles: input.inputFiles,
    outputFile: staged,
    machine: writePreset('machine', machine),
    process: writePreset('process', input.process),
    filament: writePreset('filament', input.filament),
  });
  const proc = Bun.spawn([orcaCli, ...args], {
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

  if (!existsSync(staged)) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `Slicing completed but OrcaSlicer wrote no 3MF for ${input.outputFile}\nstdout: ${stdout}\nstderr: ${stderr}`,
    };
  }

  let slicedParts: number;
  try {
    slicedParts = countSlicedParts(staged);
  } catch (e) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `Could not read the sliced parts of the 3MF OrcaSlicer wrote for ${input.outputFile}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (slicedParts !== input.inputFiles.length) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `OrcaSlicer sliced ${slicedParts} of ${input.inputFiles.length} input parts\nstdout: ${stdout}\nstderr: ${stderr}`,
    };
  }

  try {
    renameSync(staged, input.outputFile);
  } catch (e) {
    return {
      success: false,
      outputFile: input.outputFile,
      error: `Could not move the slice to ${input.outputFile}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { success: true, outputFile: input.outputFile };
}
