import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { resolveProfiles } from '../src/profiles.js';

const profileBase = join(import.meta.dir, 'fixtures', 'profiles', 'system', 'BBL');

describe('resolveProfiles', () => {
  it('resolves the P2S presets for default settings', () => {
    const r = resolveProfiles({ quality: '0.20', filament: 'Bambu PLA Basic', profileBase });
    expect(r.machine.name).toBe('Bambu Lab P2S 0.4 nozzle');
    expect(r.process.name).toBe('0.20mm Standard @BBL P2S');
    expect(r.filament.name).toBe('Bambu PLA Basic @BBL P2S');
  });

  it('resolves PETG with 0.4 nozzle suffix', () => {
    const r = resolveProfiles({ quality: '0.20', filament: 'Bambu PETG Basic', profileBase });
    expect(r.filament.name).toBe('Bambu PETG Basic @BBL P2S 0.4 nozzle');
  });

  it('resolves PLA Matte', () => {
    const r = resolveProfiles({ quality: '0.16', filament: 'Bambu PLA Matte', profileBase });
    expect(r.filament.name).toBe('Bambu PLA Matte @BBL P2S');
    expect(r.process.name).toBe('0.16mm Standard @BBL P2S');
  });

  it('resolves Generic PLA', () => {
    const r = resolveProfiles({ quality: '0.12', filament: 'Generic PLA', profileBase });
    expect(r.filament.name).toBe('Generic PLA @BBL P2S');
    expect(r.process.name).toBe('0.12mm High Quality @BBL P2S');
  });

  it('resolves Generic PETG', () => {
    const r = resolveProfiles({ quality: '0.24', filament: 'Generic PETG', profileBase });
    expect(r.filament.name).toBe('Generic PETG @BBL P2S');
    expect(r.process.name).toBe('0.24mm Standard @BBL P2S');
  });

  it('throws on unknown quality', () => {
    expect(() => resolveProfiles({ quality: '0.99', filament: 'Bambu PLA Basic', profileBase }))
      .toThrow('Unknown quality');
  });

  it('throws on unknown filament', () => {
    expect(() => resolveProfiles({ quality: '0.20', filament: 'Mystery', profileBase }))
      .toThrow('Unknown filament');
  });
});
