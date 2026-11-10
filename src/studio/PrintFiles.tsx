import { useEffect, useRef, useState } from 'react'
import { isMac, studio, type ProjectFile } from './api'

type Props = {
  project: string
  /** The project's 3MF files outside `refs/`, newest first. */
  prints: ProjectFile[]
  onError: (message: string) => void
}

/**
 * The print files bar: how many 3MF files the project holds, Reveal in Finder for the newest, and Open in Bambu Studio
 * for the newest, with a menu to open another when there are several. The app does not talk to the printer.
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
  return (
    <footer className="print-files" data-testid="print-files">
      <span className="print-count">{prints.length === 1 ? '1 print file ready' : `${prints.length} print files ready`}</span>
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
                {file.rel.split('/').pop()}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="primary" title={newest.rel} onClick={() => run(studio.openInBambu(project, newest.rel))} data-testid="open-in-bambu">
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
