import { describe, it, expect } from 'vitest';
import { resolveProfiles } from '../src/profiles.js';

describe('resolveProfiles', () => {
  it('returns correct paths for default settings', () => {
    const r = resolveProfiles({ quality: '0.20', filament: 'Bambu PLA Basic' });
    expect(r.machine).toContain('Bambu Lab P2S 0.4 nozzle.json');
    expect(r.process).toContain('0.20mm Standard @BBL P2S.json');
    expect(r.filament).toContain('Bambu PLA Basic @BBL P2S.json');
  });

  it('resolves PETG with 0.4 nozzle suffix', () => {
    const r = resolveProfiles({ quality: '0.20', filament: 'Bambu PETG Basic' });
    expect(r.filament).toContain('Bambu PETG Basic @BBL P2S 0.4 nozzle.json');
  });

  it('resolves PLA Matte', () => {
    const r = resolveProfiles({ quality: '0.16', filament: 'Bambu PLA Matte' });
    expect(r.filament).toContain('Bambu PLA Matte @BBL P2S.json');
    expect(r.process).toContain('0.16mm Standard @BBL P2S.json');
  });

  it('resolves Generic PLA', () => {
    const r = resolveProfiles({ quality: '0.12', filament: 'Generic PLA' });
    expect(r.filament).toContain('Generic PLA @BBL P2S.json');
    expect(r.process).toContain('0.12mm High Quality @BBL P2S.json');
  });

  it('resolves Generic PETG', () => {
    const r = resolveProfiles({ quality: '0.24', filament: 'Generic PETG' });
    expect(r.filament).toContain('Generic PETG @BBL P2S.json');
    expect(r.process).toContain('0.24mm Standard @BBL P2S.json');
  });

  it('throws on unknown quality', () => {
    expect(() => resolveProfiles({ quality: '0.99', filament: 'Bambu PLA Basic' }))
      .toThrow('Unknown quality');
  });

  it('throws on unknown filament', () => {
    expect(() => resolveProfiles({ quality: '0.20', filament: 'Mystery' }))
      .toThrow('Unknown filament');
  });
});
