import { describe, expect, it, afterEach } from 'bun:test';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bambuProfileBase,
  detectOrcaSlicer,
  expectedOrcaCli,
  findOnPath,
  orcaInstallHint,
  ORCA_SLICER_CLI_ENV,
} from '../src/platform';

describe('platform: findOnPath', () => {
  it('finds a common binary on PATH', () => {
    // `sh` exists on PATH on every unix CI/dev machine
    if (process.platform === 'win32') return;
    expect(findOnPath('sh')).not.toBeNull();
  });

  it('returns null for a binary that does not exist', () => {
    expect(findOnPath('definitely-not-a-real-binary-xyz')).toBeNull();
  });
});

describe('platform: detectOrcaSlicer', () => {
  afterEach(() => {
    delete process.env[ORCA_SLICER_CLI_ENV];
  });

  it('env override wins when pointing at an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-test-'));
    const fake = join(dir, 'fake-orca');
    writeFileSync(fake, '#!/bin/sh\n');
    process.env[ORCA_SLICER_CLI_ENV] = fake;
    expect(detectOrcaSlicer()).toBe(fake);
  });

  it('ignores env override pointing at a missing file', () => {
    process.env[ORCA_SLICER_CLI_ENV] = '/definitely/not/here/orca-slicer';
    expect(detectOrcaSlicer()).not.toBe('/definitely/not/here/orca-slicer');
  });
});

describe('platform: expectedOrcaCli / orcaInstallHint', () => {
  it('returns an absolute path for the current platform', () => {
    const p = expectedOrcaCli();
    expect(p.length).toBeGreaterThan(3);
    if (process.platform === 'win32') {
      expect(p).toContain('OrcaSlicer');
    } else {
      expect(p.startsWith('/')).toBe(true);
    }
  });

  it('returns a platform-appropriate install hint', () => {
    const hint = orcaInstallHint();
    if (process.platform === 'darwin') {
      expect(hint).toContain('brew');
    } else {
      expect(hint).toContain('OrcaSlicer');
    }
  });
});

describe('platform: bambuProfileBase', () => {
  it('returns an absolute path ending in BBL', () => {
    const base = bambuProfileBase();
    expect(base.endsWith('BBL')).toBe(true);
    if (process.platform !== 'win32') {
      expect(base.startsWith('/')).toBe(true);
    }
  });
});
