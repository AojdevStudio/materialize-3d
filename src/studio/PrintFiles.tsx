import { useEffect, useRef, useState } from 'react'
import bambuMark from '../assets/icons/bambulab.svg?raw'
import { isMac, studio, type PrintInfo, type ProjectFile } from './api'

type Props = {
  project: string
  /** The project's 3MF files outside `refs/`, newest first. */
  prints: ProjectFile[]
  onError: (message: string) => void
}

const fileName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)

function duration(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest} min`
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

const filament = (info: PrintInfo) => (info.filaments.length === 0 ? undefined : info.filaments.join(' + '))

function fileSummary({ rel, print }: ProjectFile): string[] {
  const parts = [fileName(rel)]
  if (print?.printSeconds !== undefined) parts.push(duration(print.printSeconds))
  if (print?.filamentGrams !== undefined) {
    const grams = print.filamentGrams < 10 ? print.filamentGrams.toFixed(1) : Math.round(print.filamentGrams)
    parts.push([`${grams} g`, filament(print)].filter((part) => part !== undefined).join(' '))
  }
  return parts
}

function sharedSettings(prints: ProjectFile[]): string[] {
  const shared = (read: (info: PrintInfo) => string | undefined) => {
    const values = new Set(prints.map(({ print }) => print && read(print)))
    return values.size === 1 ? [...values][0] : undefined
  }
  return [
    shared((info) => info.printer),
    shared(filament),
    shared((info) => (info.layerHeightMm === undefined ? undefined : `${info.layerHeightMm.toFixed(2)} mm`)),
  ].filter((part) => part !== undefined)
}

/**
 * The print files bar: how many 3MF files the project holds and what they print, Reveal in Finder for the newest, and
 * Open in Bambu Studio for the newest, with a menu to open another when there are several. The app does not talk to
 * the printer.
 */
export default function PrintFiles({ project, prints, onError }: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const run = (action: Promise<void>) => action.catch((err: unknown) => onError(String(err)))

  // The open menu closes on a click outside it, or on Escape.
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  if (prints.length === 0) return null
  const newest = prints[0]
  const line = prints.length === 1 ? fileSummary(newest) : sharedSettings(prints)
  return (
    <footer className="print-files" data-testid="print-files">
      <div className="print-summary">
        <span className="print-count">{prints.length === 1 ? '1 print file ready' : `${prints.length} print files ready`}</span>
        {line.length > 0 && (
          <span className="print-details" data-testid="print-details">
            {line.join(' · ')}
          </span>
        )}
      </div>
      <button type="button" onClick={() => run(studio.reveal(project, newest.rel))}>
        {isMac ? 'Reveal in Finder' : 'Show in folder'}
      </button>
      <div className="print-open" ref={box}>
        {open && (
          <div className="print-menu" role="menu" aria-label="Print files">
            {prints.map((file) => (
              <button
                type="button"
                key={file.rel}
                role="menuitem"
                title={file.rel}
                onClick={() => {
                  setOpen(false)
                  void run(studio.openInBambu(project, file.rel))
                }}
              >
                {fileName(file.rel)}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="primary" title={newest.rel} onClick={() => run(studio.openInBambu(project, newest.rel))} data-testid="open-in-bambu">
          <span className="print-mark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: bambuMark }} />
          Open in Bambu Studio
        </button>
        {prints.length > 1 && (
          <button
            type="button"
            className="primary print-pick"
            aria-label="Open another print file"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            data-testid="print-pick"
          >
            <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </footer>
  )
}
