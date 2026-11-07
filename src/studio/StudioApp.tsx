import { getCurrentWebview } from '@tauri-apps/api/webview'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatView as View, Project } from '../../sidecar/src/protocol'
import { autoOpens, onSidecarEvent, sidecar, studio, type ProjectFile } from './api'
import { ChatView, Composer, releaseAttachment, type Attachment } from './Chat'
import RightPanel, { type Tab } from './RightPanel'
import { buildChat } from './transcript'
import { WaitingBanner } from './Waiting'
import { UpdateBanner } from '../components/UpdateBanner'
import { checkForUpdatesAtLaunch, useUpdateEvents } from '../stores/updates'
import './studio.css'

const SUGGESTIONS = [
  'A wall mount for my dock, from a photo',
  'A replacement knob that fits this shaft',
  'A cable clip for the edge of my desk',
]

const PICTURE = /\.(png|jpe?g|heic|heif|webp|gif)$/i

/** The unsent message of the start screen, before a project exists. */
const START = 'new'

/** How long typing pauses before the draft is saved. */
const DRAFT_PAUSE_MS = 400

function newestAutoOpen(files: ProjectFile[]): ProjectFile | undefined {
  return files.filter((f) => autoOpens(f.rel)).sort((a, b) => b.modifiedMs - a.modifiedMs)[0]
}

export default function StudioApp() {
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<Project | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('preview')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  /** A failed send's error, kept with the project it was sent to and shown only there. */
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({})
  /** The unsent message. The sidecar keeps it as the open project's draft. */
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [engine, setEngine] = useState('Engine starting')
  const sendingNow = useRef(false)
  const currentId = useRef<string | null>(null)
  /** Bumped on every switch, so a slow load for a project already left is dropped. */
  const loadRequest = useRef(0)
  /** The newest file time already shown, so only newer files take over the preview. */
  const lastSeen = useRef(0)
  /** Saved drafts as the sidecar last gave them, to fill the composer when a project opens. */
  const drafts = useRef<Record<string, { text: string }>>({})
  /** A send that has not gone through yet keeps its request id, so sending it again never sends it twice. */
  const pending = useRef<{ key: string; id: string } | null>(null)

  const items = useMemo(() => buildChat(view?.entries ?? []), [view?.entries])
  const running = view?.running ?? false

  useUpdateEvents()
  useEffect(() => {
    void checkForUpdatesAtLaunch()
  }, [])

  useEffect(() => {
    sidecar('app.ping', {})
      .then(({ version }) => setEngine(`Engine ${version}`))
      .catch((err: unknown) => setEngine(String(err)))
    sidecar('state.get', {})
      .then((state) => {
        drafts.current = state.drafts
        setProjects(state.projects)
        if (currentId.current === null) setText(state.drafts[START]?.text ?? '')
      })
      .catch((err: unknown) => setError(String(err)))
    const unlisten = onSidecarEvent((event) => {
      switch (event.type) {
        case 'ready':
          setEngine(`Engine ${event.version}`)
          break
        case 'engine':
          setEngine(event.state === 'stopped' ? event.detail : 'Engine restarting')
          break
        case 'chat':
          if (event.project !== currentId.current) break
          setView((now) => {
            if (now === null || now.project !== event.project) return now
            const last = now.entries[now.entries.length - 1]?.id ?? 0
            const added = event.entries.filter((entry) => entry.id > last)
            return { ...now, entries: added.length > 0 ? [...now.entries, ...added] : now.entries, running: event.running, waiting: event.waiting, turn: event.turn }
          })
          break
        case 'login':
          if (event.step === 'open') void openUrl(event.url).catch((err: unknown) => setError(String(err)))
          if (event.step === 'ask') {
            // A choice is answered with its option's id, so the question lists them.
            const choices = event.options?.map((option) => `${option.id}: ${option.label}`).join('\n')
            const answer = window.prompt(choices === undefined ? event.message : `${event.message}\n${choices}`)
            if (answer !== null) void sidecar('auth.answer', { provider: event.provider, text: answer }).catch((err: unknown) => setError(String(err)))
          }
          if (event.step === 'failed') setError(event.detail)
          break
      }
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  // The draft is saved a moment after typing stops, for the open project or the start screen.
  useEffect(() => {
    const key = current?.id ?? START
    if ((drafts.current[key]?.text ?? '') === text) return
    const timer = window.setTimeout(() => {
      drafts.current = { ...drafts.current, [key]: { text } }
      void sidecar('drafts.set', { key, text, attachments: [] }).catch((err: unknown) => setError(String(err)))
    }, DRAFT_PAUSE_MS)
    return () => window.clearTimeout(timer)
  }, [text, current?.id])

  // Pasted pictures still waiting when the studio closes give their previews back.
  const unsent = useRef(attachments)
  unsent.current = attachments
  useEffect(() => () => unsent.current.forEach(releaseAttachment), [])

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
    if (!running) return
    const timer = window.setInterval(() => {
      void refreshFiles(current.id).catch((err: unknown) => setError(String(err)))
    }, 1500)
    return () => window.clearInterval(timer)
  }, [current, running, refreshFiles])

  /** Shows a project, or the start screen, with its saved draft. */
  const show = (project: Project | null, keepText = false) => {
    if (!keepText) {
      setText(drafts.current[project?.id ?? START]?.text ?? '')
      attachments.forEach(releaseAttachment)
      setAttachments([])
    }
    loadRequest.current += 1
    currentId.current = project?.id ?? null
    lastSeen.current = 0
    setCurrent(project)
    setView(null)
    setFiles([])
    setSelected(null)
    setTab('preview')
    setError(null)
  }

  const openProject = async (project: Project) => {
    show(project)
    const request = loadRequest.current
    try {
      const opened = await sidecar('chat.open', { project: project.id })
      if (request === loadRequest.current) setView(opened)
    } catch (err) {
      if (request === loadRequest.current) setError(String(err))
    }
  }

  const send = async () => {
    const message = text.trim()
    if ((!message && attachments.length === 0) || sendingNow.current || running) return
    sendingNow.current = true
    setSending(true)
    // The view this send belongs to. A move to another project or the start screen
    // while it runs changes `loadRequest`, and then the send leaves that view alone.
    let request = loadRequest.current
    let sentTo: string | null = null
    try {
      let project = current
      if (!project) {
        const created = await sidecar('projects.create', { title: message || 'New part' })
        project = created
        setProjects((prev) => [created, ...prev])
        if (loadRequest.current === request) {
          show(created, true)
          request = loadRequest.current
          const opened = await sidecar('chat.open', { project: created.id })
          if (loadRequest.current === request) setView(opened)
        }
      }
      const id = project.id
      sentTo = id
      const outgoing = attachments
      const images = await Promise.all(
        outgoing.map((a) => (a.kind === 'path' ? studio.importFile(id, a.path) : studio.saveBytes(id, a.name, a.bytes))),
      )
      const key = [id, message, ...images].join('\n')
      if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() }
      await sidecar('chat.send', { project: id, requestId: pending.current.id, text: message, attachments: images })
      pending.current = null
      drafts.current = { ...drafts.current, [id]: { text: '' } }
      // Text typed while this was sending is a new message, so only the sent text is cleared,
      // and only in the view that sent it.
      if (loadRequest.current === request) setText((now) => (now.trim() === message ? '' : now))
      // A picture added while these imported waits for the next message.
      setAttachments((prev) => prev.filter((a) => !outgoing.includes(a)))
      outgoing.forEach(releaseAttachment)
    } catch (err) {
      const message = String(err)
      if (sentTo !== null) {
        const project = sentTo
        setSendErrors((prev) => ({ ...prev, [project]: message }))
      } else if (loadRequest.current === request) {
        // No project was made, so the error belongs to the start screen, if it is still open.
        setError(message)
      }
    } finally {
      sendingNow.current = false
      setSending(false)
    }
  }

  const shownError = error ?? (current ? sendErrors[current.id] : undefined)
  const dismissError = () => {
    setError(null)
    if (current) setSendErrors(({ [current.id]: _, ...rest }) => rest)
  }

  const composer = (placeholder: string, autoFocus: boolean) => (
    <Composer
      text={text}
      onText={setText}
      attachments={attachments}
      onAttach={(more) => setAttachments((prev) => [...prev, ...more])}
      onRemove={(index) => {
        releaseAttachment(attachments[index])
        setAttachments((prev) => prev.filter((_, i) => i !== index))
      }}
      onSend={() => void send()}
      onStop={current ? () => void sidecar('chat.stop', { project: current.id }).catch((err: unknown) => setError(String(err))) : undefined}
      busy={sending || running}
      running={running}
      placeholder={placeholder}
      autoFocus={autoFocus}
    />
  )

  return (
    <div className={`studio ${current ? 'studio-work' : 'studio-start'}`}>
      <nav className="sessions" aria-label="Projects">
        <button type="button" className="new-project" onClick={() => show(null)} data-testid="new-project">
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
        <p className="engine" data-testid="engine">
          {engine}
        </p>
      </nav>

      <main className="chat" aria-label="Chat">
        <UpdateBanner />
        {shownError && (
          <div className="error-bar" role="alert">
            <span>{shownError}</span>
            <button type="button" onClick={dismissError} aria-label="Dismiss">×</button>
          </div>
        )}
        {current ? (
          <>
            <header className="chat-title">{current.title}</header>
            {view?.turn && (
              <p className="chat-model" data-testid="chat-model">
                {view.turn.model.modelId}
              </p>
            )}
            {view?.waiting && <WaitingBanner project={current.id} waiting={view.waiting} onError={setError} />}
            <ChatView
              project={current.id}
              items={items}
              running={running}
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
                <button type="button" key={s} onClick={() => setText(s)}>
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
