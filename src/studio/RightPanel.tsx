import { useEffect, useState } from 'react'
import { fileKind, fileUrl, formatSize, is3mf, isMac, panelFiles, studio, viewOf, VIEWS, type PanelView, type ProjectFile } from './api'
import ModelView from './ModelView'
import PrintFiles from './PrintFiles'

const LABELS: Record<PanelView, string> = { guide: 'Guide', model: 'Model', drawing: 'Drawing', files: 'Files' }

interface Props {
  project: string
  files: ProjectFile[]
  view: PanelView
  /** The file the person opened from Files or the chat. Its view shows it in place of the newest. */
  selected: string | null
  onView: (view: PanelView) => void
  /** Opens a file in its view. Null goes back to the list of files. */
  onOpen: (rel: string | null) => void
  onError: (message: string) => void
}

export function FileActions({ project, rel, onError }: { project: string; rel: string; onError: (message: string) => void }) {
  const run = (action: Promise<void>) => action.catch((err: unknown) => onError(String(err)))
  return (
    <>
      {is3mf(rel) && (
        <button type="button" className="primary" onClick={() => run(studio.openInBambu(project, rel))}>
          Open in Bambu Studio
        </button>
      )}
      <button type="button" onClick={() => run(studio.reveal(project, rel))}>
        {isMac ? 'Reveal in Finder' : 'Show in folder'}
      </button>
    </>
  )
}

function TextView({ url }: { url: string }) {
  const [text, setText] = useState('')
  useEffect(() => {
    let live = true
    fetch(url)
      .then((r) => r.text())
      .then((t) => live && setText(t))
      .catch((err: unknown) => live && setText(String(err)))
    return () => {
      live = false
    }
  }, [url])
  return <pre className="text-view">{text}</pre>
}

/** Whether the panel can show a file. A very large text file it leaves to the person's own editor. */
const previewable = (file: ProjectFile) => fileKind(file.rel) !== 'other' && !(fileKind(file.rel) === 'text' && file.size >= 400_000)

/** A project file as the panel and a pop out show it, loaded from its project, so its relative links work. */
export function FileBody({ project, rel, version }: { project: string; rel: string; version?: number }) {
  const url = fileUrl(project, rel, version)
  switch (fileKind(rel)) {
    case 'html':
      return <iframe key={url} title={rel} src={url} sandbox="allow-scripts allow-same-origin allow-modals" data-testid="html-preview" />
    case 'model':
      return <ModelView url={url} ext={rel.split('.').pop()!.toLowerCase()} />
    case 'image':
      return <img className="image-view" src={url} alt={rel} />
    case 'text':
      return <TextView url={url} />
    case 'other':
      return <p className="preview-note">No preview for this file.</p>
  }
}

function Preview({ project, file }: { project: string; file: ProjectFile | undefined }) {
  if (!file) {
    return <p className="preview-note">Guides, models, and drawings the agent makes show up here.</p>
  }
  return (
    <div className="preview-body">
      {previewable(file) ? <FileBody project={project} rel={file.rel} version={file.modifiedMs} /> : <p className="preview-note">No preview for this file.</p>}
    </div>
  )
}

function FileRow({ project, file, onOpen, onError }: { project: string; file: ProjectFile; onOpen: (rel: string) => void; onError: (m: string) => void }) {
  return (
    <li className="file-row">
      <button type="button" className="file-name" onClick={() => onOpen(file.rel)} title="Preview">
        {file.rel}
      </button>
      <span className="file-size">{formatSize(file.size)}</span>
      <FileActions project={project} rel={file.rel} onError={onError} />
    </li>
  )
}

function FileList({ project, files, onOpen, onError }: { project: string; files: ProjectFile[]; onOpen: (rel: string) => void; onError: (m: string) => void }) {
  const printFiles = files.filter((f) => is3mf(f.rel))
  const otherFiles = files.filter((f) => !is3mf(f.rel))
  return (
    <div className="files" data-testid="files-list">
      {files.length === 0 && <p className="preview-note">No files yet.</p>}
      {printFiles.length > 0 && (
        <>
          <h3>Print files</h3>
          <ul>{printFiles.map((f) => <FileRow key={f.rel} project={project} file={f} onOpen={onOpen} onError={onError} />)}</ul>
        </>
      )}
      {otherFiles.length > 0 && (
        <>
          <h3>All files</h3>
          <ul>{otherFiles.map((f) => <FileRow key={f.rel} project={project} file={f} onOpen={onOpen} onError={onError} />)}</ul>
        </>
      )}
    </div>
  )
}

/**
 * The right panel: Guide, Model, and Drawing each show the newest such file the agent wrote, or the one the person
 * opened. Files lists the project folder and shows any other file. A view with nothing to show has its tab turned off.
 * Pop out opens what the view shows in a window of its own, and shows only when there is something to open. The print
 * files bar sits under every view.
 */
export default function RightPanel({ project, files, view, selected, onView, onOpen, onError }: Props) {
  const shown = panelFiles(files)
  const picked = files.find((f) => f.rel === selected)
  const fileOf = (v: PanelView) => (picked && viewOf(picked.rel) === v ? picked : v === 'files' ? undefined : shown[v])
  const file = fileOf(view)
  return (
    <section className="right-panel" aria-label="Preview and files">
      <div className="tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            disabled={v !== 'files' && fileOf(v) === undefined}
            title={v === 'files' ? undefined : fileOf(v)?.rel}
            onClick={() => onView(v)}
            data-testid={`${v}-tab`}
          >
            {LABELS[v]}
          </button>
        ))}
        {file && previewable(file) && (
          <button type="button" className="pop-out" onClick={() => studio.popOut(project, file.rel, file.modifiedMs).catch((err: unknown) => onError(String(err)))} data-testid="pop-out">
            Pop out
            <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
              <path d="M6 4h6v6M12 4l-7.5 7.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      {view !== 'files' ? (
        <Preview project={project} file={file} />
      ) : file === undefined ? (
        <FileList project={project} files={files} onOpen={onOpen} onError={onError} />
      ) : (
        <div className="preview">
          <div className="preview-bar">
            <button type="button" onClick={() => onOpen(null)}>All files</button>
            <span className="preview-name" title={file.rel}>{file.rel}</span>
            <FileActions project={project} rel={file.rel} onError={onError} />
          </div>
          <Preview project={project} file={file} />
        </div>
      )}
      <PrintFiles project={project} prints={shown.prints} onError={onError} />
    </section>
  )
}
