import { useEffect, useState } from 'react'
import { studio } from './api'
import { FileBody } from './RightPanel'
import './studio.css'

/** How long a pop out waits between checks of its file. */
const CHECK_MS = 2000

type Shown = { project: string; rel: string; version: number }

/** The file a pop out window shows, from the page address Rust opened it with. None in the main window. */
export function popOutFile(search: string): Shown | null {
  const params = new URLSearchParams(search)
  const project = params.get('project')
  const rel = params.get('rel')
  return project === null || rel === null ? null : { project, rel, version: Number(params.get('v')) }
}

/**
 * A pop out window: one project file, filling the window. It checks its file itself, whatever the main window shows,
 * and reloads it when it changes. One check runs at a time, so an older answer never replaces a newer one.
 */
export default function PopOut({ project, rel, version: opened }: Shown) {
  const [version, setVersion] = useState(opened)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let timer = 0
    const check = async () => {
      try {
        const now = await studio.fileVersion(project, rel)
        if (!live) return
        setError(null)
        setVersion(now)
      } catch (err) {
        if (live) setError(`This window cannot read its file. ${String(err)}`)
      }
      if (live) timer = window.setTimeout(check, CHECK_MS)
    }
    void check()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [project, rel])
  return (
    <main className="pop-out-window preview-body" data-testid="pop-out-window">
      {error && <p className="preview-note">{error}</p>}
      <FileBody project={project} rel={rel} version={version} />
    </main>
  )
}
