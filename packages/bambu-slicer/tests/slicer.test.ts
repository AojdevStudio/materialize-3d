import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { ORCA_SLICER_CLI_ENV } from '../src/platform.js';
import { resolveProfiles } from '../src/profiles.js';
import { buildSliceArgs, runSlicer } from '../src/slicer.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const PROFILE_BASE = join(FIXTURES, 'profiles', 'system', 'BBL');

async function sliceWithFakeOrca(
  parts: string[],
  sliced3mf: string,
  { profileBase = PROFILE_BASE, dir = mkdtempSync(join(tmpdir(), 'fake-orca-')) } = {},
) {
  const cli = join(dir, 'orca-slicer');
  writeFileSync(
    cli,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --load-settings) settings="$2"; shift 2 ;;
    --load-filaments) filaments="$2"; shift 2 ;;
    --export-3mf) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cp "\${settings%%;*}" '${dir}/machine.json'
cp "\${settings#*;}" '${dir}/process.json'
cp "$filaments" '${dir}/filament.json'
cp '${resolve(FIXTURES, sliced3mf)}' "$out"
`,
    { mode: 0o755 },
  );
  process.env[ORCA_SLICER_CLI_ENV] = cli;

  const inputFiles = parts.map((part) => {
    const path = join(dir, part);
    writeFileSync(path, `solid ${part}\nendsolid ${part}\n`);
    return path;
  });
  const outputFile = join(dir, 'out.3mf');
  const profiles = resolveProfiles({
    quality: '0.20',
    filament: 'Bambu PLA Basic',
    profileBase,
  });
  const result = await runSlicer({ inputFiles, outputFile, ...profiles });
  const received = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf-8'));
  return {
    result,
    outputFile,
    machine: () => received('machine.json'),
    process: () => received('process.json'),
    filament: () => received('filament.json'),
  };
}

describe('buildSliceArgs', () => {
  it('builds correct argument array for single STL', () => {
    const args = buildSliceArgs({
      inputFiles: ['/tmp/model.stl'],
      outputFile: '/tmp/model.3mf',
      machine: '/profiles/machine.json',
      process: '/profiles/process.json',
      filament: '/profiles/filament.json',
    });

    expect(args).toEqual([
      '/tmp/model.stl',
      '--load-settings',
      '/profiles/machine.json;/profiles/process.json',
      '--load-filaments',
      '/profiles/filament.json',
      '--arrange',
      '1',
      '--orient',
      '1',
      '--slice',
      '0',
      '--export-3mf',
      '/tmp/model.3mf',
    ]);
  });

  it('builds correct argument array for multiple STLs', () => {
    const args = buildSliceArgs({
      inputFiles: ['/tmp/box.stl', '/tmp/cylinder.stl'],
      outputFile: '/tmp/multi.3mf',
      machine: '/profiles/machine.json',
      process: '/profiles/process.json',
      filament: '/profiles/filament.json',
    });

    // Multiple input files should all appear before --load-settings
    expect(args[0]).toBe('/tmp/box.stl');
    expect(args[1]).toBe('/tmp/cylinder.stl');
    expect(args).toContain('--export-3mf');
    expect(args[args.length - 1]).toBe('/tmp/multi.3mf');
  });
});

// runSlicer spawns OrcaSlicer with Bun.spawn, so vitest under Node skips it.
describe.skipIf(process.platform === 'win32' || typeof Bun === 'undefined')('runSlicer with the P2S profiles', () => {
  afterEach(() => {
    delete process.env[ORCA_SLICER_CLI_ENV];
  });

  it('hands OrcaSlicer presets merged with their inherits parents (#177)', async () => {
    const slice = await sliceWithFakeOrca(['box.stl'], 'sliced-one-object.3mf');

    expect(slice.machine()).toMatchObject({
      gcode_flavor: 'marlin',
      retraction_length: ['0.8'],
      extruder_clearance_max_radius: '72',
    });
    expect(slice.process()).toMatchObject({
      layer_height: '0.2',
      initial_layer_speed: ['50', '50', '50'],
    });
    expect(slice.filament()).toMatchObject({
      filament_type: ['PLA'],
      filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
      nozzle_temperature: ['220'],
    });
  });

  it('fails before slicing when a preset parent is missing from BBL.json (#177)', async () => {
    const profiles = mkdtempSync(join(tmpdir(), 'profiles-'));
    cpSync(join(FIXTURES, 'profiles'), profiles, { recursive: true });
    const manifestPath = join(profiles, 'system', 'BBL.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.filament_list = manifest.filament_list.filter(
      (entry: { name: string }) => entry.name !== 'Bambu PLA Basic @base',
    );
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const dir = mkdtempSync(join(tmpdir(), 'fake-orca-'));

    await expect(
      sliceWithFakeOrca(['box.stl'], 'sliced-one-object.3mf', {
        profileBase: join(profiles, 'system', 'BBL'),
        dir,
      }),
    ).rejects.toThrow('Bambu PLA Basic @base');
    expect(readdirSync(dir)).not.toContain('filament.json');
  });

  it('hands OrcaSlicer the P2S bed, not a default one (#178)', async () => {
    const slice = await sliceWithFakeOrca(['box.stl'], 'sliced-one-object.3mf');

    expect(slice.machine()).toMatchObject({
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      printable_height: '256',
    });
  });

  it('fails when OrcaSlicer leaves an input part unsliced (#179)', async () => {
    const dropped = await sliceWithFakeOrca(['box.stl', 'cylinder.stl'], 'sliced-one-object.3mf');
    expect(dropped.result).toMatchObject({
      success: false,
      error: expect.stringContaining('1 of 2'),
    });

    const skipped = await sliceWithFakeOrca(['box.stl', 'cylinder.stl'], 'sliced-one-skipped-of-two.3mf');
    expect(skipped.result).toMatchObject({
      success: false,
      error: expect.stringContaining('1 of 2'),
    });

    const notZip = join(mkdtempSync(join(tmpdir(), 'not-zip-')), 'out.3mf');
    writeFileSync(notZip, 'OrcaSlicer crashed mid-export');
    const unreadable = await sliceWithFakeOrca(['box.stl'], notZip);
    expect(unreadable.result).toMatchObject({ success: false });

    const complete = await sliceWithFakeOrca(['box.stl', 'cylinder.stl'], 'sliced-two-objects.3mf');
    expect(complete.result).toEqual({ success: true, outputFile: complete.outputFile });
  });
});
