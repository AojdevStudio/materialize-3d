import { useEffect, useState } from 'react'
import { onFiles } from './api'
import { FileBody } from './RightPanel'
import './studio.css'

type Shown = { project: string; rel: string; version: number }

/** The file a pop out window shows, from the page address Rust opened it with. None in the main window. */
export function popOutFile(search: string): Shown | null {
  const params = new URLSearchParams(search)
  const project = params.get('project')
  const rel = params.get('rel')
  return project === null || rel === null ? null : { project, rel, version: Number(params.get('v')) }
}

/** A pop out window: one project file, filling the window. It shows the file's newest version the main window lists. */
export default function PopOut({ project, rel, version: opened }: Shown) {
  const [version, setVersion] = useState(opened)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const unlisten = onFiles((listing) => {
      const file = listing.project === project ? listing.files.find((f) => f.rel === rel) : undefined
      if (file) setVersion(file.modifiedMs)
    })
    unlisten.catch((err: unknown) => setError(`This window cannot follow changes to ${rel}. ${String(err)}`))
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [project, rel])
  return (
    <main className="pop-out-window preview-body" data-testid="pop-out-window">
      {error && <p className="preview-note">{error}</p>}
      <FileBody project={project} rel={rel} version={version} />
    </main>
  )
}
