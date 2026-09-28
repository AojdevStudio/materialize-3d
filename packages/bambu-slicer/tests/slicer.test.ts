import { describe, it, expect } from 'vitest';
import { buildSliceArgs } from '../src/slicer.js';

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
