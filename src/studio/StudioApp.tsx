import { getCurrentWebview } from '@tauri-apps/api/webview'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AppState, type Draft, type LoginEvent, type ModelChoice, type ModelOption, type Need, type Project, type ProjectStatus, type Setup, START, type ChatView as View } from '../../sidecar/src/protocol'
import { checkSlicer, firstView, onQuitFlush, onSidecarEvent, panelFiles, sidecar, studio, viewOf, type PanelView, type ProjectFile } from './api'
import { ChatView } from './Chat'
import { Composer, releaseAttachment, savedAttachment, type PastedPicture } from './Composer'
import ModelPicker from './ModelPicker'
import RightPanel from './RightPanel'
import SetupFlow, { SetupStep } from './Setup'
import Start from './Start'
import { buildChat } from './transcript'
import Sidebar from './Sidebar'
import { ImportBlockedBanner, lockedText, SetupBanner, SignInAsk, WaitingBanner, type Blocker, type SetupCause, type TurnLogin } from './Waiting'
import { UpdateBanner } from '../components/UpdateBanner'
import { checkForUpdatesAtLaunch, useUpdateEvents } from '../stores/updates'
import './studio.css'

/** How long typing pauses before the draft is saved. */
const DRAFT_PAUSE_MS = 400

const EMPTY: Draft = { text: '', attachments: [] }

/** How often a quit tries to save a draft, and how long it waits between tries for the engine to come back. */
const QUIT_SAVE_TRIES = 4
const QUIT_RETRY_MS = 3000

/**
 * A screen's unsent message as the window holds it. The sidecar owns the draft and the send: the window only knows
 * whether the screen changed since its last completed save, and that save's revision, which a send names.
 */
type Screen = {
  draft: Draft
  /** The last save that completed: the draft it saved, and its revision. None while the store holds no draft. */
  saved?: { draft: Draft; rev: number }
  /** The save on its way. A screen has one at a time. */
  saving?: Promise<void>
  /** The send on its way. Nothing else saves the screen meanwhile, as that would replace the draft it sends. */
  sending?: Promise<void>
  /**
   * The pictures that send carries, but for any the person took out since. A sent picture leaves the next draft when
   * the send goes through, unless the person took it out and chose it again.
   */
  sendingPictures?: Set<string>
}

/** Whether the screen changed since its last completed save. Each change makes a new draft object. */
const changed = (screen: Screen) => screen.draft !== (screen.saved?.draft ?? EMPTY)

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

export default function StudioApp() {
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<Project | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  /**
   * The right panel's view. Null until the person picks one or the open project's files are first listed, and the panel
   * shows Guide's neutral note meanwhile. A pick made first stays.
   */
  const [panelView, setPanelView] = useState<PanelView | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** A failed send's error, kept with the project it was sent to and shown only there. */
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({})
  /** The open screen's draft, as its composer shows it. */
  const [shown, setShown] = useState<Draft>(EMPTY)
  const [sending, setSending] = useState(false)
  const [engine, setEngine] = useState('Engine starting')
  /** What a sign-in needs from the person: the code to enter on its page, or an answer. */
  const [signIn, setSignIn] = useState<Extract<LoginEvent, { step: 'open' | 'ask' }> | null>(null)
  const [signIns, setSignIns] = useState(0)
  const [setup, setSetup] = useState<Setup | null>(null)
  /** Counts setup's saves, so a state read that started before the newest save never puts back the setup it replaced. */
  const setupSaves = useRef(0)
  /** What the agent needs before a send, from the sidecar's check. Null until the check answers, and Send waits. */
  const [needs, setNeeds] = useState<Need[] | null>(null)
  /** Whether the newest look found the Bambu Studio the slice step uses. Null until a look answers. */
  const [slicerFound, setSlicerFound] = useState<boolean | null>(null)
  /** Counts looks for Bambu Studio, so an older look that answers late never replaces a newer one. */
  const slicerLooks = useRef(0)
  /** The person went on from setup's check, so a missing slicer gets no banner until the next launch. */
  const [wentOnInSetup, setWentOnInSetup] = useState(false)
  /** Setup's check, opened again from Fix in setup. It ends back on the screen it was opened from. */
  const [fixing, setFixing] = useState(false)
  /** The folder the chats from before the store could not be read from, when macOS keeps it from the app. */
  const [importBlocked, setImportBlocked] = useState<string | null>(null)
  /** The models of the providers the person signed in to, for the model picker. */
  const [models, setModels] = useState<ModelOption[]>([])
  /** The model a project made on the start screen runs on. Null until the saved state is read. */
  const [defaultModel, setDefaultModel] = useState<ModelChoice | null>(null)
  /** Each project's status as the sidebar keeps it, for the start screen's recent projects. */
  const [status, setStatus] = useState<Record<string, ProjectStatus>>({})
  const sendingNow = useRef(false)
  const currentId = useRef<string | null>(null)
  /** Bumped on every switch, so a slow load for a project already left is dropped. */
  const loadRequest = useRef(0)
  /**
   * The newest guide, model, or drawing time the panel has seen, so only a newer one takes the panel over. Null until
   * the open project's files are first listed, which picks the view it opens on.
   */
  const lastSeen = useRef<number | null>(null)
  /**
   * Each screen the window changed or filled from the saved state, by project id, or `START` for the start screen.
   * Typing saves its screen once typing pauses, and at once when the person leaves it. A send saves first if the
   * screen changed, then names the revision. A draft keeps its pictures as the paths of their files.
   */
  const screens = useRef<Record<string, Screen>>({})
  /** The open screen's save that waits for typing to pause. */
  const pending = useRef<{ key: string; timer: number } | null>(null)
  /** What waits for the engine's next start, as a quit's save the engine refused while it restarted. */
  const readyWaiters = useRef<(() => void)[]>([])
  /** Pastes whose pictures are still being kept, so a quit waits for them. */
  const pastes = useRef(new Set<Promise<void>>())
  /** The previews of pasted pictures, by path, freed when the window closes. */
  const previews = useRef(new Map<string, string>())
  /** Whether the person changed the start screen's pictures, so its saved ones no longer fill it. */
  const startPicturesTouched = useRef(false)
  /** The project whose chat view is loaded. Chat changes for the open project wait in `early` until it is. */
  const loaded = useRef<string | null>(null)
  const failedLoad = useRef<{ project: string; message: string } | null>(null)
  const early = useRef<View[]>([])
  /** Counts chat loads, so only the newest load of the open chat replaces its view, not an older one that answers late. */
  const loads = useRef(0)
  /** Counts readiness checks, so only the newest check's answer reaches the screen. */
  const checks = useRef(0)

  const items = useMemo(() => buildChat(view?.entries ?? [], view?.running ?? true), [view?.entries, view?.running])
  const running = view?.running ?? false
  const attachments = shown.attachments.map((path) => ({ ...savedAttachment(path), previewUrl: previews.current.get(path) }))

  useUpdateEvents()
  useEffect(() => {
    void checkForUpdatesAtLaunch()
  }, [])

  const openKey = () => currentId.current ?? START
  const draftOf = (key: string) => screens.current[key]?.draft ?? EMPTY

  /** Puts a draft on a screen, and in the composer if that screen is open. */
  const put = (key: string, draft: Draft) => {
    ;(screens.current[key] ??= { draft }).draft = draft
    if (key === openKey()) setShown(draft)
  }

  /** Empties a screen whose draft the store no longer holds. */
  const clear = (key: string) => {
    put(key, EMPTY)
    delete screens.current[key].saved
  }

  /**
   * Saves a screen until the store holds what it shows, one save at a time: a save wanted while one runs waits for it,
   * then saves the newest draft. While the screen's send is on its way, only that send saves it, and it saves `going`,
   * the draft taken at the click, so text typed while an earlier save finished stays the next message. Answers the last
   * completed save.
   */
  const flush = async (key: string, going?: Draft) => {
    const screen = screens.current[key]
    if (screen === undefined) return undefined
    while (screen.saving !== undefined) await screen.saving
    const wanted = going === undefined ? (screen.sending === undefined && changed(screen) ? screen.draft : undefined) : going
    if (wanted !== undefined && wanted !== screen.saved?.draft) {
      const draft = wanted
      const save = sidecar('drafts.set', { key, ...draft }).then(({ rev }) => {
        screen.saved = { draft, rev }
      })
      const done = () => {
        screen.saving = undefined
      }
      screen.saving = save.then(done, done)
      await save
    }
    return screen.saved
  }

  const autosave = (key: string) => void flush(key).catch((err: unknown) => setError(String(err)))

  const clearPause = () => {
    if (pending.current !== null) window.clearTimeout(pending.current.timer)
    pending.current = null
  }

  /** Changes the open screen's draft from its composer, and saves it once typing pauses. */
  const edit = (draft: Draft) => {
    const key = openKey()
    put(key, draft)
    clearPause()
    const timer = window.setTimeout(() => {
      pending.current = null
      autosave(key)
    }, DRAFT_PAUSE_MS)
    pending.current = { key, timer }
  }

  /** Takes the app's saved state: projects, drafts, and whether the old chats could be read. */
  const takeState = (state: AppState) => {
    // The saved state fills only the screens this window has not changed, since what it changed is newer.
    for (const [key, saved] of Object.entries(state.drafts)) {
      const local = screens.current[key]
      if (local === undefined) {
        const draft: Draft = { text: saved.text, attachments: saved.attachments }
        screens.current[key] = { draft, saved: { draft, rev: saved.rev } }
        if (key === openKey()) setShown(draft)
      } else if (key === START && !startPicturesTouched.current && local.draft.attachments.length === 0 && saved.attachments.length > 0) {
        // The person only typed here before the saved state came, so its pictures come back. That changes the draft.
        put(START, { ...local.draft, attachments: saved.attachments })
        autosave(START)
      }
    }
    setDefaultModel(state.settings.model)
    takeProjects(state)
  }

  /** Takes the saved projects, and whether the old chats could be read. */
  const takeProjects = (state: AppState) => {
    // A project made while this was on its way is newer than the saved list, so it stays.
    setProjects((made) => [...made.filter((p) => !state.projects.some((saved) => saved.id === p.id)), ...state.projects])
    setImportBlocked(state.importBlocked)
  }

  /**
   * Asks the sidecar what the agent still needs before a send from the open screen, as its model's provider may differ
   * from another screen's. Each change of screen, model, or sign-in asks again, so an older check's answer is about a
   * screen or a model the person left, and it is dropped.
   */
  const checkReady = () => {
    const check = ++checks.current
    const project = currentId.current
    void sidecar('setup.check', project === null ? {} : { project })
      .then((found) => check === checks.current && setNeeds(found))
      .catch((err: unknown) => check === checks.current && setError(String(err)))
  }

  /** Reads the models the person can pick, which change with each sign-in. */
  const loadModels = () => {
    void sidecar('models.list', {})
      .then(setModels)
      .catch((err: unknown) => setError(String(err)))
  }

  const findSlicer = () => {
    const look = ++slicerLooks.current
    void checkSlicer()
      .then(({ found }) => look === slicerLooks.current && setSlicerFound(found === 'ready'))
      .catch((err: unknown) => look === slicerLooks.current && setError(String(err)))
  }

  /** Setup's check ended, by going on or by Back. What it can change is read again. */
  const afterSetup = (wentOn: boolean) => {
    if (wentOn) setWentOnInSetup(true)
    checkReady()
    loadModels()
    findSlicer()
  }

  // An import retry brings old chats in as projects. Its saved state may be read before a send the person makes
  // meanwhile, so it takes the projects only, never drafts, which this window already holds.
  const retryImport = () => {
    void sidecar('legacy.import', {})
      .then(() => sidecar('state.get', {}))
      .then(takeProjects)
      .catch((err: unknown) => setError(String(err)))
  }

  useEffect(() => {
    // The first read of the saved state. If the engine stopped before it answered, it is read again once the engine is
    // back, so the projects and drafts still come.
    let stateRead = false
    const readState = () => {
      const saves = setupSaves.current
      return sidecar('state.get', {})
        .then((state) => {
          stateRead = true
          takeState(state)
          if (saves === setupSaves.current) setSetup(state.setup)
        })
        .catch((err: unknown) => setError(String(err)))
    }
    void readState()
    checkReady()
    loadModels()
    findSlicer()
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
          loadModels()
          for (const wake of readyWaiters.current.splice(0)) wake()
          if (!stateRead) void readState()
          // An engine that started again holds what a crash cut off from the window, such as a turn's last entry, so
          // the open chat is read again. The changes that arrive meanwhile are kept, as when it first opened.
          const project = currentId.current
          if (project !== null) {
            loaded.current = null
            early.current = []
            void load(project, loadRequest.current)
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
            setSignIns((count) => count + 1)
            checkReady()
            loadModels()
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

  useEffect(() => () => previews.current.forEach((url) => URL.revokeObjectURL(url)), [])
  useEffect(() => () => window.clearTimeout(pending.current?.timer), [])

  const type = (text: string) => edit({ ...draftOf(openKey()), text })

  /** Changes the open screen's attached files, and saves them with its draft. */
  const setAttachments = (paths: string[]) => {
    if (openKey() === START) startPicturesTouched.current = true
    const sending = screens.current[openKey()]?.sendingPictures
    for (const path of draftOf(openKey()).attachments) if (!paths.includes(path)) sending?.delete(path)
    edit({ ...draftOf(openKey()), attachments: paths })
  }

  /**
   * Keeps pasted pictures in files, then adds them to the screen they were pasted on: to its composer if the person is
   * there, or else to its draft, saved as any change is.
   */
  const pastePictures = (pasted: PastedPicture[]) => {
    const key = openKey()
    const landing = Promise.all(
      pasted.map(async ({ name, file }) => ({
        path: await sidecar('drafts.picture', { name, data: toBase64(new Uint8Array(await file.arrayBuffer())) }),
        file,
      })),
    )
      .then((kept) => {
        for (const { path, file } of kept) previews.current.set(path, URL.createObjectURL(file))
        const paths = [...draftOf(key).attachments, ...kept.map(({ path }) => path)]
        if (openKey() === key) {
          setAttachments(paths)
          return
        }
        if (key === START) startPicturesTouched.current = true
        put(key, { ...draftOf(key), attachments: paths })
        autosave(key)
      })
      .catch((err: unknown) => setError(String(err)))
    pastes.current.add(landing)
    void landing.finally(() => pastes.current.delete(landing))
  }

  // A quit or the window's close waits for pasted pictures still being kept and each send on its way, then saves every
  // screen, those a send just made included. Rust holds the quit meanwhile. A save the engine refused, as while it
  // restarts, is tried again once the engine is back. A draft that still cannot be saved calls the quit off.
  useEffect(() => {
    const unlisten = onQuitFlush(async () => {
      clearPause()
      await Promise.allSettled([...pastes.current])
      // It is done only when no screen sends and each holds what the store holds. A send or an edit that came while it
      // saved, so a screen skipped or changed meanwhile, means another round. A save that failed is tried again once
      // the engine is back, a few times, before the quit is called off.
      for (let failures = 0; ; ) {
        await Promise.allSettled(Object.values(screens.current).map((screen) => screen.sending))
        const saves = await Promise.allSettled(Object.keys(screens.current).map((key) => flush(key)))
        const failed = saves.some((save) => save.status === 'rejected')
        const settled = Object.values(screens.current).every((screen) => screen.sending === undefined && !changed(screen))
        if (!failed && settled) return
        if (!failed) continue
        if (++failures === QUIT_SAVE_TRIES) {
          setError('A draft could not be saved, so Materialize 3D stayed open. Quit again once the engine is back.')
          throw new Error('a draft could not be saved')
        }
        await new Promise<void>((wake) => {
          readyWaiters.current.push(wake)
          window.setTimeout(wake, QUIT_RETRY_MS)
        })
      }
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  // Files dropped anywhere on the window join the next message, as Attach adds them.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type !== 'drop') return
      setAttachments([...draftOf(openKey()).attachments, ...payload.paths])
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  const refreshFiles = useCallback(async (project: string) => {
    const list = await studio.files(project)
    if (project !== currentId.current) return
    setFiles(list)
    const shown = panelFiles(list)
    const latest = shown.latest?.modifiedMs ?? 0
    if (lastSeen.current === null) {
      lastSeen.current = latest
      setPanelView((picked) => picked ?? firstView(shown))
    } else if (shown.latest && latest > lastSeen.current) {
      lastSeen.current = latest
      setSelected(null)
      setPanelView(viewOf(shown.latest.rel))
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

  /** Shows a project, or the start screen, with its draft. The screen left is saved at once. */
  const show = (project: Project | null) => {
    clearPause()
    autosave(openKey())
    loadRequest.current += 1
    currentId.current = project?.id ?? null
    setShown(draftOf(openKey()))
    loaded.current = null
    failedLoad.current = null
    early.current = []
    lastSeen.current = null
    setCurrent(project)
    setView(null)
    setFiles([])
    setSelected(null)
    setPanelView(null)
    setError(null)
    checkReady()
  }

  /** Loads the open project's chat, with the changes that arrived while it loaded. */
  const load = async (project: string, request: number) => {
    const load = ++loads.current
    const failed = failedLoad.current
    failedLoad.current = null
    try {
      const opened = await sidecar('chat.open', { project })
      if (request !== loadRequest.current || load !== loads.current) return
      if (failed) setError((shown) => (shown === failed.message ? null : shown))
      setView(early.current.reduce(merge, opened))
      early.current = []
      loaded.current = project
    } catch (err) {
      if (request !== loadRequest.current || load !== loads.current) return
      const message = String(err)
      failedLoad.current = { project, message }
      setError(message)
    }
  }

  const openProject = async (project: Project) => {
    if (project.id === currentId.current) {
      if (failedLoad.current?.project !== project.id) return
      failedLoad.current = null
      setError(null)
    } else {
      show(project)
    }
    await load(project.id, loadRequest.current)
  }

  /**
   * Sends the open screen's draft by its revision: saved first if it changed, and a save that fails ends the send. The
   * sidecar makes the project for a first message, copies the pictures, and removes the draft it sent.
   */
  const send = async () => {
    const key = openKey()
    const screen = screens.current[key]
    if (screen === undefined || (screen.draft.text.trim() === '' && screen.draft.attachments.length === 0) || sendingNow.current || running || notReady) return
    sendingNow.current = true
    setSending(true)
    clearPause()
    let done = () => {}
    screen.sending = new Promise((resolve) => (done = resolve))
    try {
      screen.sendingPictures = new Set(screen.draft.attachments)
      const sent = await flush(key, screen.draft)
      if (sent === undefined) return
      const { project } = await sidecar('chat.send', { key, rev: sent.rev })
      setSendErrors(({ [project.id]: _, ...rest }) => rest)
      setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [project, ...prev]))
      // What changed since the save that went out is the next message. The pictures that went out leave it, but for one
      // the person took out and chose again during the send.
      const outgoing = screen.sendingPictures ?? new Set<string>()
      const next: Draft = { ...screen.draft, attachments: screen.draft.attachments.filter((path) => !outgoing.has(path)) }
      const unchanged = screen.draft === sent.draft
      if (key === START && openKey() === START) {
        // The person is still where the first message went from, so they go to its project, and what they changed
        // here meanwhile goes with them as its draft.
        clear(START)
        if (!unchanged) put(project.id, next)
        void openProject(project)
        autosave(project.id)
      } else if (unchanged) {
        clear(key)
      } else if (key !== START && next.attachments.length !== screen.draft.attachments.length) {
        put(key, next)
      }
    } catch (err) {
      const message = String(err)
      if (key !== START) setSendErrors((prev) => ({ ...prev, [key]: message }))
      else if (openKey() === START) setError(message)
    } finally {
      delete screen.sending
      delete screen.sendingPictures
      done()
      sendingNow.current = false
      setSending(false)
      autosave(key)
    }
  }

  /** Opens a file in the panel's view for it. Null goes back to the list of files. */
  const openFile = (rel: string | null) => {
    setSelected(rel)
    if (rel !== null) setPanelView(viewOf(rel))
  }

  const shownError = error ?? (current ? sendErrors[current.id] : undefined)
  const dismissError = () => {
    setError(null)
    if (current) setSendErrors(({ [current.id]: _, ...rest }) => rest)
  }

  /** The open project's own model, or the default for one from before the picker. On the start screen, the default. */
  const chosenModel = (current ? projects.find((p) => p.id === current.id)?.model : undefined) ?? defaultModel

  const waiting = view?.waiting ?? null
  const turnLogin: TurnLogin | undefined = waiting?.kind === 'login' ? { kind: 'turn-login', provider: waiting.provider, name: waiting.name } : undefined
  const nextWaitsForLogin = turnLogin !== undefined && turnLogin.provider === chosenModel?.provider
  const blocker: Blocker | undefined = needs?.[0] ?? (nextWaitsForLogin ? turnLogin : undefined)
  const cause: SetupCause | undefined = blocker ?? turnLogin ?? (slicerFound === false && !wentOnInSetup ? { kind: 'slicer' } : undefined)
  const notReady = needs === null || blocker !== undefined

  /**
   * Saves a pick: the open project's model, or on the start screen the default the next project takes. The check runs
   * again then, as the new model's provider may differ.
   */
  const pickModel = (model: ModelChoice) => {
    const project = current?.id
    if (project === undefined) {
      void sidecar('settings.set', { model })
        .then((state) => {
          setDefaultModel(state.settings.model)
          checkReady()
        })
        .catch((err: unknown) => setError(String(err)))
      return
    }
    void sidecar('projects.setModel', { project, model })
      .then(() => {
        setProjects((all) => all.map((p) => (p.id === project ? { ...p, model } : p)))
        checkReady()
      })
      .catch((err: unknown) => setError(String(err)))
  }

  const composer = (placeholder: string, autoFocus: boolean) => (
    <Composer
      text={shown.text}
      onText={type}
      attachments={attachments}
      onAttach={(more) => setAttachments([...draftOf(openKey()).attachments, ...more.map((a) => a.path)])}
      onPaste={pastePictures}
      onRemove={(index) => {
        releaseAttachment(attachments[index])
        previews.current.delete(shown.attachments[index])
        setAttachments(draftOf(openKey()).attachments.filter((_, i) => i !== index))
      }}
      onSend={() => void send()}
      onStop={current ? () => void sidecar('chat.stop', { project: current.id }).catch((err: unknown) => setError(String(err))) : undefined}
      busy={sending || running || needs === null}
      running={running}
      placeholder={placeholder}
      locked={blocker === undefined ? undefined : lockedText(blocker)}
      autoFocus={autoFocus}
      hint={current ? undefined : 'Photo, PDF, 3MF, STL'}
      sendLabel={current ? 'Send' : 'Start'}
      picker={blocker !== undefined && models.length === 0 ? null : <ModelPicker models={models} chosen={chosenModel} onPick={pickModel} />}
    />
  )

  const errorBar = shownError && (
    <div className="error-bar" role="alert">
      <span>{shownError}</span>
      <button type="button" onClick={dismissError} aria-label="Dismiss">×</button>
    </div>
  )
  const signInAsk = signIn && (
    <SignInAsk
      key={signIn.step === 'ask' ? signIn.message : signIn.url}
      ask={signIn}
      onAnswer={(answer) => {
        setSignIn(null)
        void sidecar('auth.answer', { provider: signIn.provider, text: answer }).catch((err: unknown) => setError(String(err)))
      }}
    />
  )

  if (setup !== null && !setup.done) {
    return (
      <SetupFlow
        setup={setup}
        onSaved={(state) => {
          setupSaves.current += 1
          setSetup(state.setup)
          if (state.setup.done) afterSetup(true)
        }}
        onError={setError}
        error={errorBar}
        signIn={signInAsk}
        signIns={signIns}
      />
    )
  }

  if (fixing) {
    return (
      <SetupStep
        step="check"
        refused={turnLogin?.provider}
        onDone={(wentOn) => {
          setFixing(false)
          afterSetup(wentOn)
        }}
        onError={setError}
        error={errorBar}
        signIn={signInAsk}
        signIns={signIns}
      />
    )
  }

  return (
    <div className={`studio ${current ? 'studio-work' : 'studio-start'}`}>
      <Sidebar
        projects={projects}
        current={current?.id ?? null}
        engine={engine}
        onOpen={(project) => void openProject(project)}
        onNew={() => show(null)}
        onError={setError}
        onStatus={setStatus}
      />

      <main className="chat" aria-label="Chat">
        <UpdateBanner />
        {errorBar}
        {importBlocked !== null && <ImportBlockedBanner folder={importBlocked} onRetry={retryImport} onError={setError} />}
        {signInAsk}
        {cause !== undefined && <SetupBanner cause={cause} onFix={() => setFixing(true)} />}
        {current ? (
          <>
            <header className="chat-title">{current.title}</header>
            {view?.turn && (
              <p className="chat-model" data-testid="chat-model">
                {view.turn.model.modelId}
              </p>
            )}
            {waiting?.kind === 'error' && <WaitingBanner project={current.id} waiting={waiting} onError={setError} />}
            <ChatView
              project={current.id}
              items={items}
              running={running}
              startedMs={view?.turn?.startedMs}
              onPreview={openFile}
              onError={setError}
            />
            {composer('Reply, paste a link, or attach a file', false)}
          </>
        ) : (
          <Start
            projects={projects}
            status={status}
            composer={composer('Describe the part, paste a link, or attach a file', true)}
            onSuggest={type}
            onOpen={(project) => void openProject(project)}
            onError={setError}
          />
        )}
      </main>

      {current && (
        <RightPanel project={current.id} files={files} view={panelView ?? 'guide'} selected={selected} onView={setPanelView} onOpen={openFile} onError={setError} />
      )}
    </div>
  )
}
