import { getCurrentWebview } from '@tauri-apps/api/webview'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, Draft, LoginEvent, Need, ChatView as View, Project } from '../../sidecar/src/protocol'
import { autoOpens, onQuitFlush, onSidecarEvent, sidecar, studio, type ProjectFile } from './api'
import { ChatView, Composer, releaseAttachment, savedAttachment, type Attachment, type PastedPicture } from './Chat'
import RightPanel, { type Tab } from './RightPanel'
import { buildChat } from './transcript'
import { ImportBlockedBanner, ReadinessBanner, SignInAsk, WaitingBanner } from './Waiting'
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

/** A pasted picture's bytes as base64, to cross the sidecar's pipe. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
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
  /** What the agent needs before a send, from the sidecar's check. Null until the check answers, and Send waits. */
  const [needs, setNeeds] = useState<Need[] | null>(null)
  /** The folder the chats from before the store could not be read from, when macOS keeps it from the app. */
  const [importBlocked, setImportBlocked] = useState<string | null>(null)
  const sendingNow = useRef(false)
  const currentId = useRef<string | null>(null)
  /** Bumped on every switch, so a slow load for a project already left is dropped. */
  const loadRequest = useRef(0)
  /** The newest file time already shown, so only newer files take over the preview. */
  const lastSeen = useRef(0)
  /**
   * Drafts by project, or `new` for the start screen, to fill the composer when a screen opens. The rules: typing saves
   * the draft of its screen once typing pauses, or at once when the person leaves the screen or sends. A send removes
   * the draft only when it holds the sent text. Making a project moves the start screen's draft to it. A draft keeps
   * its pictures too, as the paths of their files.
   */
  const drafts = useRef<Record<string, Draft>>({})
  /** A draft not saved yet, and the timer that saves it. */
  const unsaved = useRef<{ key: string; draft: Draft; timer: number } | null>(null)
  /**
   * Messages whose send has not gone through, by project. Sending one again sends the same pictures under the same
   * request id, so a send whose reply was lost never sends it twice.
   */
  const pending = useRef(new Map<string, { text: string; outgoing: Attachment[]; images: string[]; id: string }>())
  /** Whether the person typed on the start screen, so the saved draft no longer fills it. */
  const typedOnStart = useRef(false)
  /** Whether the person changed the start screen's pictures, so its saved ones no longer fill it. */
  const startPicturesTouched = useRef(false)
  /** The composer's text as it is now, for a send that finishes after the person typed more. */
  const composerText = useRef('')
  /** The project whose chat view is loaded. Chat changes for the open project wait in `early` until it is. */
  const loaded = useRef<string | null>(null)
  /** Counts the person's edits to the composer, so a send clears only the text it sent, not a later edit that reads the same. */
  const edits = useRef(0)
  const early = useRef<View[]>([])
  /** Counts chat loads, so only the newest load of the open chat replaces its view, not an older one that answers late. */
  const loads = useRef(0)

  composerText.current = text
  const items = useMemo(() => buildChat(view?.entries ?? [], view?.running ?? true), [view?.entries, view?.running])
  const running = view?.running ?? false

  useUpdateEvents()
  useEffect(() => {
    void checkForUpdatesAtLaunch()
  }, [])

  /** Takes the app's saved state: projects, drafts, and whether the old chats could be read. */
  const takeState = (state: AppState) => {
    // Drafts saved in this window since are newer, and text already typed stays. The start screen's saved pictures
    // still come back when the person only typed there, even if that typing was saved.
    const saved = state.drafts[START]
    const local = drafts.current[START]
    const restoreStart = !startPicturesTouched.current && saved !== undefined && saved.attachments.length > 0 && (local?.attachments.length ?? 0) === 0
    drafts.current = { ...state.drafts, ...drafts.current }
    if (restoreStart) drafts.current = { ...drafts.current, [START]: { text: local?.text ?? saved.text, attachments: saved.attachments } }
    // A project made while this was on its way is newer than the saved list, so it stays.
    setProjects((made) => [...made.filter((p) => !state.projects.some((saved) => saved.id === p.id)), ...state.projects])
    setImportBlocked(state.importBlocked)
    if (currentId.current === null) {
      const draft = drafts.current[START]
      if (!typedOnStart.current) setText(draft?.text ?? '')
      // Pictures the person has not touched yet come back even when they typed first. A save that waits for that typing
      // then keeps them too.
      const restored = (draft?.attachments ?? []).map(savedAttachment)
      if (unsent.current.length === 0 && restored.length > 0) {
        // Typing already saved, or waiting to be, gets the pictures too.
        if (typedOnStart.current) setPictures(restored)
        else {
          unsent.current = restored
          setAttachments(restored)
        }
      }
    }
  }

  /** Asks the sidecar what the agent still needs before a send. */
  const checkReady = () => {
    void sidecar('setup.check', {})
      .then(setNeeds)
      .catch((err: unknown) => setError(String(err)))
  }

  const retryImport = () => {
    void sidecar('legacy.import', {})
      .then(() => sidecar('state.get', {}))
      .then(takeState)
      .catch((err: unknown) => setError(String(err)))
  }

  useEffect(() => {
    sidecar('state.get', {})
      .then(takeState)
      .catch((err: unknown) => setError(String(err)))
    checkReady()
    // The listener is in place before the ping, so no engine change is missed, and a ping that answers late never
    // hides one.
    let engineChanged = false
    const unlisten = onSidecarEvent((event) => {
      switch (event.type) {
        case 'ready': {
          engineChanged = true
          setEngine(`Engine ${event.version}`)
          // A check that failed while the engine started again is asked again, so Send does not stay off.
          checkReady()
          // An engine that started again holds what a crash cut off from the window, such as a turn's last entry, so
          // the open chat is read again. The changes that arrive meanwhile are kept, as when it first opened.
          const project = currentId.current
          if (project !== null) {
            loaded.current = null
            early.current = []
            void load(project, loadRequest.current).catch((err: unknown) => setError(String(err)))
          }
          break
        }
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
          if (event.step === 'done') {
            setSignIn(null)
            checkReady()
          }
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

  /** Saves the draft now, if one waits to be saved. */
  const saveDraft = async () => {
    const waiting = unsaved.current
    if (waiting === null) return
    window.clearTimeout(waiting.timer)
    unsaved.current = null
    drafts.current = { ...drafts.current, [waiting.key]: waiting.draft }
    await sidecar('drafts.set', { key: waiting.key, ...waiting.draft })
  }

  // The composer's pictures as they are now, for a draft saved from outside a render, and to free their previews.
  const unsent = useRef(attachments)
  unsent.current = attachments
  useEffect(() => () => unsent.current.forEach(releaseAttachment), [])

  /** Saves the open screen's draft once typing pauses: its text and its pictures. */
  const queueDraft = (text: string, pictures: Attachment[]) => {
    if (unsaved.current !== null) window.clearTimeout(unsaved.current.timer)
    const timer = window.setTimeout(() => void saveDraft().catch((err: unknown) => setError(String(err))), DRAFT_PAUSE_MS)
    unsaved.current = { key: currentId.current ?? START, draft: { text, attachments: pictures.map((a) => a.path) }, timer }
  }

  const type = (value: string) => {
    edits.current += 1
    setText(value)
    queueDraft(value, unsent.current)
    if (currentId.current === null) typedOnStart.current = true
  }
  useEffect(() => () => window.clearTimeout(unsaved.current?.timer), [])

  /** Changes the composer's pictures, and saves them with the draft. */
  const setPictures = (next: Attachment[]) => {
    if (currentId.current === null) startPicturesTouched.current = true
    unsent.current = next
    setAttachments(next)
    queueDraft(composerText.current, next)
  }

  /** Keeps pasted pictures in files, then adds them to the screen they were pasted on, if the person is still there. */
  const pastePictures = (pasted: PastedPicture[]) => {
    const request = loadRequest.current
    void Promise.all(
      pasted.map(async ({ name, file }) => ({
        name,
        path: await sidecar('drafts.picture', { name, data: toBase64(new Uint8Array(await file.arrayBuffer())) }),
        file,
      })),
    )
      .then((kept) => {
        if (request !== loadRequest.current) return
        setPictures([...unsent.current, ...kept.map(({ name, path, file }) => ({ name, path, previewUrl: URL.createObjectURL(file) }))])
      })
      .catch((err: unknown) => setError(String(err)))
  }

  // A quit or the window's close first saves the draft still waiting, then lets the quit go on.
  useEffect(() => {
    const unlisten = onQuitFlush(saveDraft)
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
      setPictures([...unsent.current, ...pictures.map(savedAttachment)])
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
      const draft = drafts.current[project?.id ?? START]
      setText(draft?.text ?? '')
      attachments.forEach(releaseAttachment)
      setAttachments((draft?.attachments ?? []).map(savedAttachment))
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
    const load = ++loads.current
    const opened = await sidecar('chat.open', { project })
    if (request !== loadRequest.current || load !== loads.current) return
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
    if ((!message && attachments.length === 0) || sendingNow.current || running || notReady) return
    sendingNow.current = true
    setSending(true)
    // The view this send belongs to. A move to another project or the start screen
    // while it runs changes `loadRequest`, and then the send leaves that view alone.
    let request = loadRequest.current
    let sentTo: string | null = null
    try {
      await saveDraft()
      const sentEdits = edits.current
      // The saved draft this send went out with: the open project's, or the start screen's, which may move to the new
      // project. A save after it is a newer draft, which the send leaves alone.
      const sentDraft = drafts.current[current?.id ?? START]
      const createdHere = current === null
      let project = current
      if (!project) {
        const title = message || 'New part'
        const created = await sidecar('projects.create', { title })
        project = created
        // The sidecar moved the start screen's draft to the new project in the same commit when the draft's text is the
        // project's title, as for a first message with text. One of only pictures stays on the start screen.
        const { [START]: started, ...rest } = drafts.current
        if (started !== undefined && started.text.trim() === title) drafts.current = { ...rest, [created.id]: started }
        setProjects((prev) => [created, ...prev])
        if (loadRequest.current === request) {
          // The person stayed on the screen this was sent from, so text typed while the project was made follows them
          // to it, and the start screen is empty again. A save still waiting belongs to that screen, so it goes too.
          const typed = composerText.current
          if (unsaved.current !== null) window.clearTimeout(unsaved.current.timer)
          unsaved.current = null
          if (typed.trim() !== message) {
            drafts.current = { ...drafts.current, [created.id]: { text: typed, attachments: [] }, [START]: { text: '', attachments: [] } }
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
            images: await Promise.all(outgoing.map((a) => studio.importFile(id, a.path))),
            id: crypto.randomUUID(),
          }
      pending.current.set(id, sendable)
      await sidecar('chat.send', { project: id, requestId: sendable.id, text: message, attachments: sendable.images })
      pending.current.delete(id)
      setSendErrors(({ [id]: _, ...rest }) => rest)
      // Text typed while this was sending is a new message, even one that reads the same, so the sent text is cleared
      // only when nothing was typed since, and only in the view that sent it.
      // The sent project's saved draft goes, unless a newer draft for it was saved since, or waits to be.
      if (sentDraft !== undefined && drafts.current[id] === sentDraft && unsaved.current?.key !== id) {
        drafts.current = { ...drafts.current, [id]: { text: '', attachments: [] } }
      }
      if (edits.current === sentEdits && loadRequest.current === request) setText((now) => (now.trim() === message ? '' : now))
      // The sent pictures leave every draft that names them: the one waiting to be saved, the saved one of this
      // project, and the start screen's, which a first message of only pictures leaves in place. A picture added
      // while these imported waits for the next message.
      const sent = new Set(outgoing.map((a) => a.path))
      const unsentNames = (draft: Draft) => draft.attachments.filter((path) => !sent.has(path))
      // Only this send's drafts: its project's, and the start screen's when this send made the project from it.
      const keys = createdHere ? [id, START] : [id]
      if (unsaved.current !== null && keys.includes(unsaved.current.key)) {
        unsaved.current.draft = { ...unsaved.current.draft, attachments: unsentNames(unsaved.current.draft) }
      }
      for (const key of keys) {
        const draft = drafts.current[key]
        if (draft === undefined || draft.attachments.every((path) => !sent.has(path))) continue
        drafts.current = { ...drafts.current, [key]: { ...draft, attachments: unsentNames(draft) } }
        if (unsaved.current?.key !== key) {
          void sidecar('drafts.set', { key, ...drafts.current[key] }).catch((err: unknown) => setError(String(err)))
        }
      }
      // The composer of the sent project, if it is open now, even after a visit elsewhere brought its draft back.
      if (currentId.current === id) {
        unsent.current = unsent.current.filter((a) => !sent.has(a.path))
        setAttachments(unsent.current)
      }
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

  // Send waits for the check, and stays off while the agent lacks a sign-in, uv, or Python.
  const notReady = needs === null || needs.length > 0
  const composer = (placeholder: string, autoFocus: boolean) => (
    <>
      {needs !== null && <ReadinessBanner needs={needs} onCheck={checkReady} onError={setError} />}
      <Composer
        text={text}
        onText={type}
        attachments={attachments}
        onAttach={(more) => setPictures([...unsent.current, ...more])}
        onPaste={pastePictures}
        onRemove={(index) => {
          releaseAttachment(attachments[index])
          setPictures(unsent.current.filter((_, i) => i !== index))
        }}
        onSend={() => void send()}
        onStop={current ? () => void sidecar('chat.stop', { project: current.id }).catch((err: unknown) => setError(String(err))) : undefined}
        busy={sending || running || notReady}
        running={running}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
    </>
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
        {importBlocked !== null && <ImportBlockedBanner folder={importBlocked} onRetry={retryImport} onError={setError} />}
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
