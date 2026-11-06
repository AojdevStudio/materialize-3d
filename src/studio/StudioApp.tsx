import { getCurrentWebview } from '@tauri-apps/api/webview'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { autoOpens, studio, type Project, type ProjectFile, type StudioEvent } from './api'
import { ChatView, Composer, type Attachment } from './Chat'
import RightPanel, { type Tab } from './RightPanel'
import { buildChat } from './transcript'
import './studio.css'

const SUGGESTIONS = [
  'A wall mount for my dock, from a photo',
  'A replacement knob that fits this shaft',
  'A cable clip for the edge of my desk',
]

const PICTURE = /\.(png|jpe?g|heic|heif|webp|gif)$/i

/** Adds a live event at its transcript line. One the loaded history already holds is a repeat. */
function appendEvent(events: StudioEvent[], seq: number, event: StudioEvent): StudioEvent[] {
  return seq < events.length ? events : [...events, event]
}

function newestAutoOpen(files: ProjectFile[]): ProjectFile | undefined {
  return files.filter((f) => autoOpens(f.rel)).sort((a, b) => b.modifiedMs - a.modifiedMs)[0]
}

export default function StudioApp() {
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<Project | null>(null)
  const [events, setEvents] = useState<StudioEvent[]>([])
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('preview')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const currentId = useRef<string | null>(null)
  /** Bumped on every switch, so a slow history load for a project already left is dropped. */
  const loadRequest = useRef(0)
  /** Live events that arrive while the open project's history is loading. */
  const pending = useRef<{ seq: number; event: StudioEvent }[] | null>(null)
  /** The newest file time already shown, so only newer files take over the preview. */
  const lastSeen = useRef(0)

  const chat = useMemo(() => buildChat(events, current?.path ?? ''), [events, current?.path])

  useEffect(() => {
    studio.projects().then(setProjects).catch((err: unknown) => setError(String(err)))
    const unlisten = studio.onEvent((project, seq, event) => {
      if (project !== currentId.current) return
      if (pending.current) pending.current.push({ seq, event })
      else setEvents((prev) => appendEvent(prev, seq, event))
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  // Pictures dropped anywhere on the window join the next message.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type !== 'drop') return
      const pictures = payload.paths.filter((p) => PICTURE.test(p))
      if (pictures.length === 0) {
        setError('Drop a picture: PNG, JPG, HEIC, WebP, or GIF.')
        return
      }
      setAttachments((prev) => [...prev, ...pictures.map((path) => ({ kind: 'path' as const, name: path.split(/[\\/]/).pop() ?? path, path }))])
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  const refreshFiles = useCallback(async (project: string) => {
    const list = await studio.files(project)
    if (project !== currentId.current) return
    setFiles(list)
    const newest = newestAutoOpen(list)
    if (newest && newest.modifiedMs > lastSeen.current) {
      lastSeen.current = newest.modifiedMs
      setSelected(newest.rel)
      setTab('preview')
    }
  }, [])

  // While the agent works, new files show up within a couple of seconds.
  useEffect(() => {
    if (!current) return
    void refreshFiles(current.id).catch((err: unknown) => setError(String(err)))
    if (!chat.running) return
    const timer = window.setInterval(() => {
      void refreshFiles(current.id).catch((err: unknown) => setError(String(err)))
    }, 1500)
    return () => window.clearInterval(timer)
  }, [current, chat.running, refreshFiles])

  const show = (project: Project | null, history: StudioEvent[]) => {
    loadRequest.current += 1
    pending.current = null
    currentId.current = project?.id ?? null
    lastSeen.current = 0
    setCurrent(project)
    setEvents(history)
    setFiles([])
    setSelected(null)
    setTab('preview')
    setError(null)
  }

  const openProject = async (project: Project) => {
    show(project, [])
    const request = loadRequest.current
    pending.current = []
    try {
      const history = await studio.transcript(project.id)
      if (request !== loadRequest.current) return
      const live = pending.current
      pending.current = null
      setEvents(live.reduce((events, { seq, event }) => appendEvent(events, seq, event), history))
    } catch (err) {
      if (request === loadRequest.current) setError(String(err))
    }
  }

  const send = async (text: string) => {
    try {
      let project = current
      if (!project) {
        project = await studio.createProject(text || 'New part')
        setProjects((prev) => [project!, ...prev])
        show(project, [])
      }
      const id = project.id
      const images = await Promise.all(
        attachments.map((a) => (a.kind === 'path' ? studio.importFile(id, a.path) : studio.saveBytes(id, a.name, a.bytes))),
      )
      setAttachments([])
      await studio.send(id, text, images)
    } catch (err) {
      setError(String(err))
    }
  }

  const composer = (placeholder: string, autoFocus: boolean) => (
    <Composer
      attachments={attachments}
      onAttach={(more) => setAttachments((prev) => [...prev, ...more])}
      onRemove={(index) => setAttachments((prev) => prev.filter((_, i) => i !== index))}
      onSend={send}
      onStop={current ? () => void studio.cancel(current.id) : undefined}
      running={chat.running}
      placeholder={placeholder}
      draft={draft}
      autoFocus={autoFocus}
    />
  )

  return (
    <div className={`studio ${current ? 'studio-work' : 'studio-start'}`}>
      <nav className="sessions" aria-label="Projects">
        <button type="button" className="new-project" onClick={() => show(null, [])} data-testid="new-project">
          New project
        </button>
        <ul>
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" aria-current={p.id === current?.id} onClick={() => void openProject(p)} title={p.title}>
                {p.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="chat" aria-label="Chat">
        {error && (
          <div className="error-bar" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}
        {current ? (
          <>
            <header className="chat-title">{current.title}</header>
            <ChatView
              project={current.id}
              items={chat.items}
              running={chat.running}
              onPreview={(rel) => {
                setSelected(rel)
                setTab('preview')
              }}
              onError={setError}
            />
            {composer('Reply, paste a link, or drop a picture', false)}
          </>
        ) : (
          <div className="start" data-testid="start-screen">
            <h1>What are we making?</h1>
            {composer('Describe the part. Paste a link or drop a photo if you have one.', true)}
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button type="button" key={s} onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      {current && (
        <RightPanel project={current.id} files={files} selected={selected} tab={tab} onTab={setTab} onSelect={setSelected} onError={setError} />
      )}
    </div>
  )
}
