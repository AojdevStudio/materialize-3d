#!/usr/bin/env bun

import { parseArgs } from 'util';
import { resolveProfiles, listProfiles } from './profiles.js';
import { runSlicer } from './slicer.js';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    input: { type: 'string' },
    output: { type: 'string' },
    quality: { type: 'string', default: '0.20' },
    filament: { type: 'string', default: 'Bambu PLA Basic' },
    'list-profiles': { type: 'boolean', default: false },
  },
  strict: true,
});

if (values['list-profiles']) {
  const { qualities, filaments } = listProfiles();
  console.log('Quality profiles (--quality):');
  for (const q of qualities) console.log(`  ${q}`);
  console.log('\nFilament profiles (--filament):');
  for (const f of filaments) console.log(`  ${f}`);
  process.exit(0);
}

if (!values.input || !values.output) {
  console.error('Usage: bun run cli.ts --input <stl> --output <3mf> [--quality 0.20] [--filament "Bambu PLA Basic"]');
  console.error('       bun run cli.ts --list-profiles');
  process.exit(1);
}

const inputFiles = values.input.split(/\s+/).filter(Boolean);
const profiles = resolveProfiles({
  quality: values.quality!,
  filament: values.filament!,
});

console.log(`Slicing ${inputFiles.length} file(s)...`);
console.log(`  Quality: ${values.quality}`);
console.log(`  Filament: ${values.filament}`);
console.log(`  Output: ${values.output}`);

const result = await runSlicer({
  inputFiles,
  outputFile: values.output,
  ...profiles,
});

if (result.success) {
  const stat = Bun.file(result.outputFile);
  const sizeKB = Math.round((await stat.size) / 1024);
  console.log(`\nSuccess! Output: ${result.outputFile} (${sizeKB} KB)`);
} else {
  console.error(`\nSlicing failed: ${result.error}`);
  process.exit(1);
}
