import { describe, expect, it } from 'vitest'
import { filamentName, printerAndNozzle, printerModel, withoutPrinter } from './presetNames'

describe('printer name', () => {
  it('names a printer by its model, without the maker or the nozzle', () => {
    expect(printerModel('Bambu Lab P2S 0.4 nozzle')).toBe('P2S')
    expect(printerModel('Bambu Lab A1 mini 0.2 nozzle')).toBe('A1 mini')
    expect(printerModel('My P2S for PETG')).toBe('My P2S for PETG')
  })
})

// The same names as the table in `src-tauri/src/bambu/preset_name.rs`, with the same answers.
describe('preset names, as Rust reads them', () => {
  it.each([
    ['Bambu Lab P2S 0.4 nozzle', ['Bambu Lab P2S', '0.4'], 'P2S'],
    ['Bambu Lab A1 mini 0.2 nozzle', ['Bambu Lab A1 mini', '0.2'], 'A1 mini'],
    ['Bambu Lab X1 Carbon 0.6 nozzle', ['Bambu Lab X1 Carbon', '0.6'], 'X1 Carbon'],
    ['Bambu Lab P2S 10.4 nozzle', ['Bambu Lab P2S', '10.4'], 'P2S'],
    ['Prusa MK3S 0.4 nozzle', ['Prusa MK3S', '0.4'], 'Prusa MK3S 0.4 nozzle'],
    ['Bambu Lab P2S nozzle', ['Bambu Lab', 'P2S'], 'Bambu Lab P2S nozzle'],
    ['Bambu Lab P2S', undefined, 'Bambu Lab P2S'],
    ['Bambu Lab P2S 0.4 nozzle - mine', undefined, 'Bambu Lab P2S 0.4 nozzle - mine'],
    ['Bambu PETG Basic @BBL P2S 0.4 nozzle', ['Bambu PETG Basic @BBL P2S', '0.4'], 'Bambu PETG Basic @BBL P2S 0.4 nozzle'],
    ['0.20mm Standard @BBL P2S', undefined, '0.20mm Standard @BBL P2S'],
  ])('%s', (machine, parts, model) => {
    expect(printerAndNozzle(machine)).toEqual(parts)
    expect(printerModel(machine)).toBe(model)
  })

  it('drops the printer from a preset, and the maker from a filament', () => {
    expect(withoutPrinter('Bambu PETG Basic @BBL P2S 0.4 nozzle')).toBe('Bambu PETG Basic')
    expect(withoutPrinter('0.20mm Standard @BBL P2S')).toBe('0.20mm Standard')
    expect(filamentName('Bambu PETG Basic @BBL P2S')).toBe('PETG Basic')
    expect(filamentName('Generic PLA @BBL P2S')).toBe('Generic PLA')
    expect(filamentName('Bambu PLA Basic')).toBe('PLA Basic')
  })
})
