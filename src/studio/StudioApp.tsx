import { getCurrentWebview } from '@tauri-apps/api/webview'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LoginEvent, ChatView as View, Project } from '../../sidecar/src/protocol'
import { autoOpens, onSidecarEvent, sidecar, studio, type ProjectFile } from './api'
import { ChatView, Composer, releaseAttachment, type Attachment } from './Chat'
import RightPanel, { type Tab } from './RightPanel'
import { buildChat } from './transcript'
import { SignInAsk, WaitingBanner } from './Waiting'
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

/** A chat change on top of a view: entries joined by id, and the turn's state as the change gives it. */
/**
 * A chat with a change applied. Entries only grow, so each one is kept. The running state comes from whichever was read
 * last, so a change read before the open chat, which can arrive after it, never puts back a turn that already ended.
 */
function merge(view: View, change: View): View {
  const byId = new Map(view.entries.map((entry) => [entry.id, entry]))
  for (const entry of change.entries) byId.set(entry.id, entry)
  const entries = [...byId.values()].sort((a, b) => a.id - b.id)
  if (change.seq < view.seq) return { ...view, entries }
  return { ...view, entries, running: change.running, waiting: change.waiting, turn: change.turn, seq: change.seq }
}

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
  /** What a sign-in needs from the person: the code to enter on its page, or an answer. */
  const [signIn, setSignIn] = useState<Extract<LoginEvent, { step: 'open' | 'ask' }> | null>(null)
  const sendingNow = useRef(false)
  const currentId = useRef<string | null>(null)
  /** Bumped on every switch, so a slow load for a project already left is dropped. */
  const loadRequest = useRef(0)
  /** The newest file time already shown, so only newer files take over the preview. */
  const lastSeen = useRef(0)
  /**
   * Drafts by project, or `new` for the start screen, to fill the composer when a screen opens. The rules: typing saves
   * the draft of its screen once typing pauses, or at once when the person leaves the screen or sends. A send removes
   * the draft only when it holds the sent text. Making a project moves the start screen's draft to it.
   */
  const drafts = useRef<Record<string, { text: string }>>({})
  /** Typed text not saved yet, and the timer that saves it. */
  const unsaved = useRef<{ key: string; text: string; timer: number } | null>(null)
  /**
   * Messages whose send has not gone through, by project. Sending one again sends the same pictures under the same
   * request id, so a send whose reply was lost never sends it twice.
   */
  const pending = useRef(new Map<string, { text: string; outgoing: Attachment[]; images: string[]; id: string }>())
  /** Whether the person typed on the start screen, so the saved draft no longer fills it. */
  const typedOnStart = useRef(false)
  /** The composer's text as it is now, for a send that finishes after the person typed more. */
  const composerText = useRef('')
  /** The project whose chat view is loaded. Chat changes for the open project wait in `early` until it is. */
  const loaded = useRef<string | null>(null)
  const early = useRef<View[]>([])

  composerText.current = text
  const items = useMemo(() => buildChat(view?.entries ?? [], view?.running ?? true), [view?.entries, view?.running])
  const running = view?.running ?? false

  useUpdateEvents()
  useEffect(() => {
    void checkForUpdatesAtLaunch()
  }, [])

  useEffect(() => {
    sidecar('state.get', {})
      .then((state) => {
        // Drafts saved in this window since are newer, and text already typed stays.
        drafts.current = { ...state.drafts, ...drafts.current }
        // A project made while this was on its way is newer than the saved list, so it stays.
        setProjects((made) => [...made.filter((p) => !state.projects.some((saved) => saved.id === p.id)), ...state.projects])
        if (currentId.current === null && !typedOnStart.current) setText(drafts.current[START]?.text ?? '')
      })
      .catch((err: unknown) => setError(String(err)))
    // The listener is in place before the ping, so no engine change is missed, and a ping that answers late never
    // hides one.
    let engineChanged = false
    const unlisten = onSidecarEvent((event) => {
      switch (event.type) {
        case 'ready':
          engineChanged = true
          setEngine(`Engine ${event.version}`)
          break
        case 'engine':
          engineChanged = true
          setEngine(event.state === 'stopped' ? event.detail : 'Engine restarting')
          break
        case 'chat':
          if (event.project !== currentId.current) break
          if (loaded.current !== event.project) {
            early.current.push(event)
            break
          }
          setView((now) => now && merge(now, event))
          break
        case 'login':
          if (event.step === 'open') {
            void openUrl(event.url).catch((err: unknown) => setError(String(err)))
            setSignIn(event.code === undefined ? null : event)
          }
          if (event.step === 'ask') setSignIn(event)
          if (event.step === 'done') setSignIn(null)
          if (event.step === 'failed') {
            setSignIn(null)
            setError(event.detail)
          }
          break
      }
    })
    unlisten
      .then(() => sidecar('app.ping', {}))
      .then(({ version }) => engineChanged || setEngine(`Engine ${version}`))
      .catch((err: unknown) => engineChanged || setEngine(String(err)))
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  /** Saves the typed text now, if any waits to be saved. */
  const saveDraft = async () => {
    const draft = unsaved.current
    if (draft === null) return
    window.clearTimeout(draft.timer)
    unsaved.current = null
    drafts.current = { ...drafts.current, [draft.key]: { text: draft.text } }
    await sidecar('drafts.set', { key: draft.key, text: draft.text, attachments: [] })
  }

  const type = (value: string) => {
    setText(value)
    if (unsaved.current !== null) window.clearTimeout(unsaved.current.timer)
    const timer = window.setTimeout(() => void saveDraft().catch((err: unknown) => setError(String(err))), DRAFT_PAUSE_MS)
    unsaved.current = { key: currentId.current ?? START, text: value, timer }
    if (currentId.current === null) typedOnStart.current = true
  }
  useEffect(() => () => window.clearTimeout(unsaved.current?.timer), [])

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
    void saveDraft().catch((err: unknown) => setError(String(err)))
    if (!keepText) {
      setText(drafts.current[project?.id ?? START]?.text ?? '')
      attachments.forEach(releaseAttachment)
      setAttachments([])
    }
    loadRequest.current += 1
    currentId.current = project?.id ?? null
    loaded.current = null
    early.current = []
    lastSeen.current = 0
    setCurrent(project)
    setView(null)
    setFiles([])
    setSelected(null)
    setTab('preview')
    setError(null)
  }

  /** Loads the open project's chat, with the changes that arrived while it loaded. */
  const load = async (project: string, request: number) => {
    const opened = await sidecar('chat.open', { project })
    if (request !== loadRequest.current) return
    setView(early.current.reduce(merge, opened))
    early.current = []
    loaded.current = project
  }

  const openProject = async (project: Project) => {
    show(project)
    const request = loadRequest.current
    try {
      await load(project.id, request)
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
      await saveDraft()
      let project = current
      if (!project) {
        const created = await sidecar('projects.create', { title: message || 'New part' })
        project = created
        // The sidecar moved the start screen's draft to the new project in the same commit, when it held this message.
        const { [START]: started, ...rest } = drafts.current
        if (started?.text.trim() === message) drafts.current = { ...rest, [created.id]: started }
        setProjects((prev) => [created, ...prev])
        if (loadRequest.current === request) {
          // The person stayed on the screen this was sent from, so text typed while the project was made follows them
          // to it, and the start screen is empty again. A save still waiting belongs to that screen, so it goes too.
          const typed = composerText.current
          if (unsaved.current !== null) window.clearTimeout(unsaved.current.timer)
          unsaved.current = null
          if (typed.trim() !== message) {
            drafts.current = { ...drafts.current, [created.id]: { text: typed }, [START]: { text: '' } }
            for (const [key, value] of [[created.id, typed], [START, '']]) {
              void sidecar('drafts.set', { key, text: value, attachments: [] }).catch((err: unknown) => setError(String(err)))
            }
          }
          show(created, true)
          request = loadRequest.current
          await load(created.id, request)
        }
      }
      const id = project.id
      sentTo = id
      const outgoing = attachments
      const last = pending.current.get(id)
      const again =
        last !== undefined &&
        last.text === message &&
        last.outgoing.length === outgoing.length &&
        last.outgoing.every((a, i) => a === outgoing[i])
      const sendable = again
        ? last
        : {
            text: message,
            outgoing,
            images: await Promise.all(
              outgoing.map((a) => (a.kind === 'path' ? studio.importFile(id, a.path) : studio.saveBytes(id, a.name, a.bytes))),
            ),
            id: crypto.randomUUID(),
          }
      pending.current.set(id, sendable)
      await sidecar('chat.send', { project: id, requestId: sendable.id, text: message, attachments: sendable.images })
      pending.current.delete(id)
      setSendErrors(({ [id]: _, ...rest }) => rest)
      if (drafts.current[id]?.text.trim() === message) drafts.current = { ...drafts.current, [id]: { text: '' } }
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
      onText={type}
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
        {signIn && (
          <SignInAsk
            key={signIn.step === 'ask' ? signIn.message : signIn.url}
            ask={signIn}
            onAnswer={(answer) => {
              setSignIn(null)
              void sidecar('auth.answer', { provider: signIn.provider, text: answer }).catch((err: unknown) => setError(String(err)))
            }}
          />
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
                <button type="button" key={s} onClick={() => type(s)}>
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
