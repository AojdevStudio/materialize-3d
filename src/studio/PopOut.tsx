import { useEffect } from 'react'
import { FileBody } from './RightPanel'
import { useTheme } from './theme'
import './studio.css'

/** The file a pop out window shows, from the page address Rust opened it with. None in the main window. */
export function popOutFile(search: string): { project: string; rel: string } | null {
  const params = new URLSearchParams(search)
  const project = params.get('project')
  const rel = params.get('rel')
  return project === null || rel === null ? null : { project, rel }
}

/** A pop out window: one project file, filling the window, in the app's theme. */
export default function PopOut({ project, rel }: { project: string; rel: string }) {
  // The theme toggle is in the main window. Its choice reaches this window through the storage they share.
  useEffect(() => {
    const follow = (event: StorageEvent) => {
      if (event.key === 'materialize-3d.theme') useTheme.setState({ theme: event.newValue === 'dark' ? 'dark' : 'light' })
    }
    window.addEventListener('storage', follow)
    return () => window.removeEventListener('storage', follow)
  }, [])
  return (
    <main className="pop-out-window preview-body" data-testid="pop-out-window">
      <FileBody project={project} rel={rel} />
    </main>
  )
}
