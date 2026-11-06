import { useEffect, useState } from 'react'
import { fileKind, fileUrl, formatSize, is3mf, isMac, studio, type ProjectFile } from './api'
import ModelView from './ModelView'

export type Tab = 'preview' | 'files'

interface Props {
  project: string
  files: ProjectFile[]
  selected: string | null
  tab: Tab
  onTab: (tab: Tab) => void
  onSelect: (rel: string) => void
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

function Preview({ project, file, onError }: { project: string; file: ProjectFile | undefined; onError: (m: string) => void }) {
  if (!file) {
    return <p className="preview-note">Models, drawings, and guides the agent makes show up here.</p>
  }
  const url = fileUrl(project, file.rel, file.modifiedMs)
  const kind = fileKind(file.rel)
  return (
    <div className="preview">
      <div className="preview-bar">
        <span className="preview-name" title={file.rel}>{file.rel}</span>
        <FileActions project={project} rel={file.rel} onError={onError} />
      </div>
      <div className="preview-body">
        {kind === 'html' && (
          <iframe key={url} title={file.rel} src={url} sandbox="allow-scripts allow-popups allow-modals" data-testid="html-preview" />
        )}
        {kind === 'model' && <ModelView url={url} ext={file.rel.split('.').pop()!.toLowerCase()} />}
        {kind === 'image' && <img className="image-view" src={url} alt={file.rel} />}
        {kind === 'text' && file.size < 400_000 && <TextView url={url} />}
        {(kind === 'other' || (kind === 'text' && file.size >= 400_000)) && <p className="preview-note">No preview for this file.</p>}
      </div>
    </div>
  )
}

function FileRow({ project, file, onSelect, onError }: { project: string; file: ProjectFile; onSelect: (rel: string) => void; onError: (m: string) => void }) {
  return (
    <li className="file-row">
      <button type="button" className="file-name" onClick={() => onSelect(file.rel)} title="Preview">
        {file.rel}
      </button>
      <span className="file-size">{formatSize(file.size)}</span>
      <FileActions project={project} rel={file.rel} onError={onError} />
    </li>
  )
}

export default function RightPanel({ project, files, selected, tab, onTab, onSelect, onError }: Props) {
  const printFiles = files.filter((f) => is3mf(f.rel))
  const otherFiles = files.filter((f) => !is3mf(f.rel))
  const open = (rel: string) => {
    onSelect(rel)
    onTab('preview')
  }
  return (
    <section className="right-panel" aria-label="Preview and files">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => onTab('preview')}>
          Preview
        </button>
        <button type="button" role="tab" aria-selected={tab === 'files'} onClick={() => onTab('files')} data-testid="files-tab">
          Files {files.length > 0 && <span className="count">{files.length}</span>}
        </button>
      </div>
      {tab === 'preview' ? (
        <Preview project={project} file={files.find((f) => f.rel === selected)} onError={onError} />
      ) : (
        <div className="files" data-testid="files-list">
          {files.length === 0 && <p className="preview-note">No files yet.</p>}
          {printFiles.length > 0 && (
            <>
              <h3>Print files</h3>
              <ul>{printFiles.map((f) => <FileRow key={f.rel} project={project} file={f} onSelect={open} onError={onError} />)}</ul>
            </>
          )}
          {otherFiles.length > 0 && (
            <>
              <h3>All files</h3>
              <ul>{otherFiles.map((f) => <FileRow key={f.rel} project={project} file={f} onSelect={open} onError={onError} />)}</ul>
            </>
          )}
        </div>
      )}
    </section>
  )
}
