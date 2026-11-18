/**
 * The parts of a Bambu preset's name, read the way `src-tauri/src/bambu/preset_name.rs` reads them. Bambu Studio names a
 * printer preset `<printer> <nozzle> nozzle`, as in `Bambu Lab P2S 0.4 nozzle`, and a filament or process preset
 * `<name> @BBL <printer>`, sometimes with more after the printer, as in `Bambu PETG Basic @BBL P2S 0.4 nozzle`.
 */

const MAKER = 'Bambu Lab '

/** The printer and its nozzle size in mm: `Bambu Lab P2S 0.4 nozzle` is `Bambu Lab P2S` and `0.4`. */
export function printerAndNozzle(machine: string): [printer: string, nozzle: string] | undefined {
  if (!machine.endsWith(' nozzle')) return undefined
  const rest = machine.slice(0, -' nozzle'.length)
  const space = rest.lastIndexOf(' ')
  return space === -1 ? undefined : [rest.slice(0, space), rest.slice(space + 1)]
}

/** A printer's short name: the model of a Bambu Lab printer preset, as `P2S`, or else the whole name. */
export function printerModel(machine: string): string {
  const printer = printerAndNozzle(machine)?.[0]
  return printer?.startsWith(MAKER) ? printer.slice(MAKER.length) : machine
}

/** A preset without the printer it is for: `Bambu PETG Basic @BBL P2S 0.4 nozzle` is `Bambu PETG Basic`. */
export const withoutPrinter = (preset: string) => preset.split(' @')[0]

/** A filament preset without the maker's name or the printer: `Bambu PETG Basic @BBL P2S` is `PETG Basic`. */
export const filamentName = (preset: string) => withoutPrinter(preset).replace(/^Bambu /, '')
