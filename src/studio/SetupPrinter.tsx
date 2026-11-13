import { useEffect, useState } from 'react'
import type { Plate, Printer } from '../../sidecar/src/protocol'
import { checkSlicer, sidecar, studio, type BambuLastUsed, type PrinterChoice } from './api'
import type { StepProps } from './Setup'

type Choice = Required<Printer>
type Nozzle = PrinterChoice['nozzles'][number]

type Fitted = { choice: Choice; printer: PrinterChoice; nozzle: Nozzle }
type Offer = { printers: PrinterChoice[]; confirmable: Fitted | undefined; start: Fitted }

const PLATE: Record<Plate, string> = {
  'Cool Plate': 'Cool Plate',
  'Engineering Plate': 'Engineering Plate',
  'High Temp Plate': 'High Temp Plate',
  'Textured PEI Plate': 'Textured PEI Plate',
  'Supertack Plate': 'SuperTack Plate',
}

/** A Bambu Lab preset's name without the printer it is for: `Bambu PETG Basic @BBL P2S 0.4 nozzle` is `Bambu PETG Basic`. */
export const presetName = (name: string) => name.split(' @')[0]
const quality = (process: string) => presetName(process).replace(/^([\d.]+)mm /, '$1 mm ')

function fit(printers: PrinterChoice[], wanted: { machine: string | null | undefined; process?: string | null; filament?: string | null; plate?: Plate | null }): Fitted | undefined {
  for (const printer of printers) {
    const nozzle = printer.nozzles.find((entry) => entry.machine === wanted.machine)
    if (nozzle === undefined) continue
    const keep = (name: string | null | undefined, names: string[], otherwise: string) => (name && names.includes(name) ? name : otherwise)
    const choice = {
      machine: nozzle.machine,
      process: keep(wanted.process, nozzle.processes, nozzle.process),
      filament: keep(wanted.filament, nozzle.filaments, nozzle.filament),
      plate: wanted.plate && printer.plates.includes(wanted.plate) ? wanted.plate : printer.defaultPlate,
    }
    return { choice, printer, nozzle }
  }
}

function offer(printers: PrinterChoice[], first: Fitted, last: BambuLastUsed | null, saved: Printer): Offer {
  const read = last && { machine: last.machine.system, process: last.process?.system, filament: last.filament?.system, plate: last.plate }
  const fromRead = read ? fit(printers, read) : undefined
  const confirmable = fromRead && read?.process === fromRead.choice.process && read.filament === fromRead.choice.filament ? fromRead : undefined
  return { printers, confirmable, start: fromRead ?? fit(printers, saved) ?? first }
}

/**
 * Setup's printer step. It shows what Bambu Studio last used when all of it can be saved. Otherwise it shows a pick of
 * every printer the validated Bambu Studio slices for. With no such Bambu Studio nothing can be saved, so the step
 * passes and the saved printer stays.
 */
export default function SetupPrinter({ next, back, onError }: StepProps) {
  const [shown, setShown] = useState<Offer | null>(null)
  const [picking, setPicking] = useState<Fitted | null>(null)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void checkSlicer()
      .then(async (slicer) => {
        if (slicer.found !== 'ready') return current && next()
        const [printers, last, { settings }] = await Promise.all([studio.printers(), studio.bambuLastUsed(), sidecar('state.get', {})])
        if (!current) return
        const first = fit(printers, { machine: printers[0]?.nozzles[0]?.machine })
        if (first === undefined) return onError('Bambu Studio lists no printer to pick.')
        const made = offer(printers, first, last, settings.printer)
        setShown(made)
        if (made.confirmable === undefined) setPicking(made.start)
      })
      .catch((err: unknown) => current && onError(String(err)))
    return () => {
      current = false
    }
  }, [])

  const save = (choice: Choice) => {
    setSaving(true)
    setRefused(null)
    void sidecar('printer.set', choice)
      .then(next, (err: unknown) => setRefused(String(err)))
      .finally(() => setSaving(false))
  }

  if (shown === null) {
    return (
      <>
        <h1>Your printer</h1>
        <p>Checking…</p>
      </>
    )
  }

  const reason = refused && (
    <p className="setup-hint" role="alert">
      {refused}
    </p>
  )

  if (picking === null && shown.confirmable !== undefined) {
    const confirmable = shown.confirmable
    const { choice, printer, nozzle } = confirmable
    const rows = [
      ['Printer', printer.printer],
      ['Nozzle', `${nozzle.nozzle} mm`],
      ['Filament', presetName(choice.filament)],
      ['Plate', PLATE[choice.plate]],
      ['Quality', quality(choice.process)],
    ]
    return (
      <>
        <h1>Is this your printer?</h1>
        <p>Read from the settings you last used in Bambu Studio.</p>
        <dl className="setup-printer" data-testid="printer-found">
          {rows.map(([label, text]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
        {reason}
        <div className="setup-actions">
          <button type="button" disabled={saving} onClick={() => setPicking(confirmable)}>
            Change
          </button>
          <button type="button" className="primary" disabled={saving} onClick={() => save(choice)}>
            Looks right
          </button>
        </div>
      </>
    )
  }

  const current = picking ?? shown.start
  const { choice, printer, nozzle } = current
  const pick = (change: Partial<Choice>) => {
    setRefused(null)
    setPicking(fit(shown.printers, { ...choice, ...change }) ?? current)
  }
  const pickPrinter = (name: string) => {
    const nozzles = shown.printers.find((entry) => entry.printer === name)?.nozzles ?? []
    const same = nozzles.find((entry) => entry.nozzle === nozzle.nozzle) ?? nozzles.find((entry) => entry.nozzle === '0.4') ?? nozzles[0]
    if (same !== undefined) pick({ machine: same.machine })
  }
  const fields: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }[] = [
    { label: 'Printer', value: printer.printer, options: shown.printers.map((entry) => [entry.printer, entry.printer]), onChange: pickPrinter },
    { label: 'Nozzle', value: choice.machine, options: printer.nozzles.map((entry) => [entry.machine, `${entry.nozzle} mm`]), onChange: (machine) => pick({ machine }) },
    { label: 'Filament', value: choice.filament, options: nozzle.filaments.map((name) => [name, presetName(name)]), onChange: (filament) => pick({ filament }) },
    { label: 'Plate', value: choice.plate, options: printer.plates.map((plate) => [plate, PLATE[plate]]), onChange: (plate) => pick({ plate: printer.plates.find((entry) => entry === plate) }) },
    { label: 'Quality', value: choice.process, options: nozzle.processes.map((name) => [name, quality(name)]), onChange: (process) => pick({ process }) },
  ]

  return (
    <>
      <h1>Pick your printer</h1>
      <p>The agent slices for this printer.</p>
      <fieldset className="setup-fields" disabled={saving}>
        {fields.map(({ label, value, options, onChange }) => (
          <label key={label}>
            {label}
            <select value={value} onChange={(event) => onChange(event.target.value)}>
              {options.map(([option, text]) => (
                <option key={option} value={option}>
                  {text}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      {reason}
      <div className="setup-actions">
        <button type="button" disabled={saving} onClick={() => (shown.confirmable === undefined ? void back() : setPicking(null))}>
          Back
        </button>
        <button type="button" className="primary" disabled={saving} onClick={() => save(choice)}>
          Save
        </button>
      </div>
    </>
  )
}
