import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect } from 'react'
import { create } from 'zustand'
import type { AppState, ChatView, Login, LoginEvent, Methods, ModelOption, Need, Project, ProjectStatus, ProviderId, Settings, Setup, SidecarEvent } from '../../sidecar/src/protocol'
import { checkSlicer, onSidecarEvent, sidecar, studio, type Listening, type ProjectFile } from './api'
import { firstView, panelFiles, viewOf, type PanelView } from './files'

const STATE_RETRY_MS = 3000

type StudioState = {
  /** The project on screen. Null on the start screen. */
  current: Project | null
  /** The open project's chat. Null until its first load lands. */
  view: ChatView | null
  files: ProjectFile[]
  /** The file open in the panel. Null shows the list of files. */
  selected: string | null
  /**
   * The right panel's view. Null until the person picks one or the open project's files are first listed, and the panel
   * shows Guide's neutral note meanwhile. A pick made first stays.
   */
  panelView: PanelView | null
  /** Each project's status: the sidecar's last read, with whether its turn runs as this engine run's chat events said. */
  status: Record<string, ProjectStatus>
  error: string | null
  /** The engine's version, or what it is doing while it does not run. */
  engine: string
  /** Null until the saved state is read. */
  setup: Setup | null
  /** Null until the saved state is read. */
  settings: Settings | null
  /** The folder the chats from before the store could not be read from, when macOS keeps it from the app. */
  importBlocked: string | null
  /** What the agent needs before a send from the open screen, from the sidecar's check. Null until the check answers, and Send waits. */
  needs: Need[] | null
  /** The models of the providers the person signed in to. */
  models: ModelOption[]
  /** The sign-ins, or `failed`. Undefined while a fresh read is on its way. */
  logins: Login[] | 'failed' | undefined
  /** What a running sign-in needs from the person: the code to enter on its page, or an answer. */
  signIn: Extract<LoginEvent, { step: 'open' | 'ask' }> | null
  /** Whether the newest look found the Bambu Studio the slice step uses. Null until a look answers. */
  slicerFound: boolean | null
  /** The person went on from setup's check, so a missing slicer gets no banner until the next launch. */
  wentOnInSetup: boolean
}

const EMPTY: StudioState = {
  current: null,
  view: null,
  files: [],
  selected: null,
  panelView: null,
  status: {},
  error: null,
  engine: 'Engine starting',
  setup: null,
  settings: null,
  importBlocked: null,
  needs: null,
  models: [],
  logins: undefined,
  signIn: null,
  slicerFound: null,
  wentOnInSetup: false,
}

/**
 * The window's one store: chats, project status, the saved setup and settings, the sign-ins, and what the agent needs
 * before a send. Every sidecar event lands here once, chat events ordered by `seq`, and the screens read it.
 * `useStudioEvents` feeds it while the window is open.
 */
export const useStudio = create<StudioState>()(() => EMPTY)

const { getState: get, setState: set } = useStudio

type ChatState = Pick<ChatView, 'running' | 'seq'>

/**
 * Whether a chat state read at `seq` is newer than the one kept. `seq` grows with each read of a chat, across sidecar
 * runs too. The one ordering rule for chat events and chat loads.
 */
const newer = (kept: ChatState | undefined, seq: number) => kept === undefined || seq > kept.seq

/**
 * A chat with a change applied. Entries only grow, so each one is kept. The rest comes from whichever was read last, so
 * a change read before the open chat, which can arrive after it, never puts back a turn that already ended.
 */
function merge(view: ChatView, change: ChatView): ChatView {
  const byId = new Map(view.entries.map((entry) => [entry.id, entry]))
  for (const entry of change.entries) byId.set(entry.id, entry)
  const entries = [...byId.values()].sort((a, b) => a.id - b.id)
  if (!newer(view, change.seq)) return { ...view, entries }
  return { ...view, entries, running: change.running, waiting: change.waiting, turn: change.turn, handoffs: change.handoffs, seq: change.seq }
}

/**
 * The startup read of the saved state. Only its first answer is taken: every startup read began before a send could go,
 * so a later answer would bring back what that send took.
 */
type SavedRead = { taken: boolean; retry?: number; take: (state: AppState) => void }

/** What the store keeps outside its state: it changes as each event arrives, and nothing renders from it. */
type Kept = {
  read: Record<string, ProjectStatus>
  /**
   * Each project's newest chat state from this engine run's events. Events come in order, so they are newer than any
   * status read, and a read that comes back late cannot move a project out of Working or into it.
   */
  runs: Record<string, ChatState>
  reading: { busy: boolean; again: boolean }
  /** The project whose chat view is loaded. Chat changes for the open project wait in `early` until it is. */
  loaded: string | null
  early: ChatView[]
  failedLoad: { project: string; message: string } | null
  /**
   * The newest guide, model, or drawing time the panel has seen, so only a newer one takes the panel over. Null until
   * the open project's files are first listed, which picks the view it opens on.
   */
  lastSeen: number | null
  events: Listening | null
  /** Whether an engine event came, so a version ping that answers late never hides it. */
  engineChanged: boolean
  /** What waits for the engine's next start, as a quit's save the engine refused while it restarted. */
  readyWaiters: (() => void)[]
  saved: SavedRead | null
  /** Counts setup's saves, so a state read that started before the newest save never puts back the setup it replaced. */
  setupSaves: number
  savingSetup: boolean
  /** The newest save that answers the app's state, while it runs. The next save waits for it. */
  saving: Promise<AppState> | null
}

const fresh = (): Kept => ({
  read: {},
  runs: {},
  reading: { busy: false, again: false },
  loaded: null,
  early: [],
  failedLoad: null,
  lastSeen: null,
  events: null,
  engineChanged: false,
  readyWaiters: [],
  saved: null,
  setupSaves: 0,
  savingSetup: false,
  saving: null,
})

let kept = fresh()
/** Bumped on every switch and every reset, so a slow load for a project already left is dropped. */
let switches = 0

function reset() {
  window.clearTimeout(kept.saved?.retry)
  kept = fresh()
  switches += 1
}
/** Counts chat loads, so only the newest load of the open chat replaces its view, not an older one that answers late. */
let loads = 0
/** Counts readiness checks, so only the newest check's answer reaches the screen. */
let checks = 0
/** Counts looks for Bambu Studio, so an older look that answers late never replaces a newer one. */
let looks = 0
/** Counts sign-in reads, so an older read that answers late never replaces a newer one. */
let loginReads = 0
/** Counts model list reads, so an older read that answers late never replaces a newer one. */
let modelReads = 0

const withRuns = () =>
  Object.fromEntries(Object.entries(kept.read).map(([id, s]) => [id, { ...s, running: kept.runs[id]?.running ?? s.running }]))

export const setError = (error: string | null) => set({ error })

/** Reads every project's status again. One read at a time, and a read asked for meanwhile runs once that one ends. */
export function readStatus() {
  const reading = kept.reading
  reading.again = true
  if (reading.busy) return
  reading.busy = true
  void (async () => {
    while (reading.again) {
      reading.again = false
      try {
        const read = await sidecar('projects.status', {})
        if (reading !== kept.reading) return
        kept.read = read
        set({ status: withRuns() })
      } catch (err) {
        if (reading === kept.reading) setError(String(err))
      }
    }
    reading.busy = false
  })()
}

export function markPrinted(project: string) {
  void sidecar('projects.markPrinted', { project })
    .then(readStatus)
    .catch((err: unknown) => setError(String(err)))
}

/**
 * Asks the sidecar what the agent still needs before a send from the open screen, as its model's provider may differ
 * from another screen's. Each change of screen, model, or sign-in asks again, so an older check's answer is about a
 * screen or a model the person left, and it is dropped.
 */
export function checkReady() {
  const check = ++checks
  const project = get().current?.id
  void sidecar('setup.check', project === undefined ? {} : { project })
    .then((needs) => check === checks && set({ needs }))
    .catch((err: unknown) => check === checks && setError(String(err)))
}

/**
 * Reads the models the person can pick, which change with each sign-in. A read that fails is tried again after a
 * pause, as the start screen keeps Send off until the list comes.
 */
export function loadModels() {
  const read = ++modelReads
  void sidecar('models.list', {})
    .then((models) => read === modelReads && set({ models }))
    .catch((err: unknown) => {
      if (read !== modelReads) return
      setError(String(err))
      window.setTimeout(() => read === modelReads && loadModels(), STATE_RETRY_MS)
    })
}

function findSlicer() {
  const look = ++looks
  void checkSlicer()
    .then(({ found }) => look === looks && set({ slicerFound: found === 'ready' }))
    .catch((err: unknown) => look === looks && setError(String(err)))
}

/** Reads the sign-ins. With `clear`, they show as being checked until it answers, as on a screen that opens. */
export function readLogins(clear = false) {
  const read = ++loginReads
  if (clear) set({ logins: undefined })
  void sidecar('auth.status', {}).then(
    (logins) => read === loginReads && set({ logins }),
    (err: unknown) => {
      if (read !== loginReads) return
      set({ logins: 'failed' })
      setError(String(err))
    },
  )
}

/** Setup's check ended, by going on or by Back. What it can change is read again. */
export function afterSetup(wentOn: boolean) {
  if (wentOn) set({ wentOnInSetup: true })
  checkReady()
  loadModels()
  findSlicer()
}

/**
 * Runs a save that answers the app's state once the save before it ended, and takes the settings it answers. One at a
 * time, so an older answer never lands after a newer one and puts back what that one changed. An answer for a window
 * that closed meanwhile is not taken.
 */
function saveState(call: () => Promise<AppState>) {
  const at = kept
  const save = () =>
    call().then((state) => {
      if (at === kept) set({ settings: state.settings })
      return state
    })
  const turn = at.saving === null ? save() : at.saving.then(save, save)
  at.saving = turn
  const ended = () => {
    if (at.saving === turn) at.saving = null
  }
  void turn.then(ended, ended)
  return turn
}

export const saveSettings = (change: Methods['settings.set']['params']) => saveState(() => sidecar('settings.set', change))

export const savePrinter = (choice: Methods['printer.set']['params']) => saveState(() => sidecar('printer.set', choice))

/**
 * Saves setup's step, one save at a time: a save asked for while one runs does nothing. The next step's screen can save
 * as soon as it shows, so the save in flight ends before its answer moves setup on. An answer for a window that closed
 * meanwhile moves nothing.
 */
export async function saveSetup(change: Setup) {
  const at = kept
  if (at.savingSetup) return
  at.savingSetup = true
  const state = await saveState(() => sidecar('setup.set', change)).finally(() => {
    at.savingSetup = false
  })
  if (at !== kept) return
  at.setupSaves += 1
  set({ setup: state.setup })
  if (state.setup.done) afterSetup(true)
}

export function answerSignIn(provider: ProviderId, text: string) {
  set({ signIn: null })
  void sidecar('auth.answer', { provider, text }).catch((err: unknown) => setError(String(err)))
}

export function onNextReady(wake: () => void) {
  kept.readyWaiters.push(wake)
}

function readState(saved: SavedRead) {
  const saves = kept.setupSaves
  void sidecar('state.get', {})
    .then(
      (state) => {
        if (saved !== kept.saved || saved.taken) return
        saved.taken = true
        set({ settings: state.settings, importBlocked: state.importBlocked, ...(saves === kept.setupSaves ? { setup: state.setup } : {}) })
        saved.take(state)
      },
      (err: unknown) => {
        if (saved !== kept.saved || saved.taken) return
        setError(String(err))
        window.clearTimeout(saved.retry)
        saved.retry = window.setTimeout(() => {
          if (!saved.taken) readState(saved)
        }, STATE_RETRY_MS)
      },
    )
    .catch((err: unknown) => setError(String(err)))
}

/**
 * Reads what the window starts from: the saved state, which Send waits for, what the agent needs, the models, Bambu
 * Studio, and the engine's version. A state read that fails is tried again after a pause, and at once when the engine
 * is back. Answers the saved state the window took, for the drafts and the project list.
 */
export function start(): Promise<AppState> {
  const taken = new Promise<AppState>((take) => {
    const saved: SavedRead = { taken: false, take }
    kept.saved = saved
    readState(saved)
  })
  checkReady()
  loadModels()
  findSlicer()
  // The listener is in place before the ping, so no engine change is missed, and a ping that answers late never hides
  // one.
  const at = kept
  void at.events?.ready
    .then(() => sidecar('app.ping', {}))
    .then(({ version }) => at === kept && !at.engineChanged && set({ engine: `Engine ${version}` }))
    .catch((err: unknown) => at === kept && !at.engineChanged && set({ engine: String(err) }))
  return taken
}

/**
 * An import retry brings old chats in as projects. Answers the saved state read after it, for its projects. That read
 * may come before a send the person makes meanwhile, so it brings no drafts.
 */
export async function importAgain() {
  await sidecar('legacy.import', {})
  const state = await sidecar('state.get', {})
  set({ importBlocked: state.importBlocked })
  return state
}

/** Shows a project, or the start screen with null, from a clean slate. `load` reads the project's chat. */
export function show(project: Project | null) {
  switches += 1
  kept.loaded = null
  kept.failedLoad = null
  kept.early = []
  kept.lastSeen = null
  set({ current: project, view: null, files: [], selected: null, panelView: null, error: null })
}

/** Whether the open project's last load failed. Clears that failure and its error, so a `load` can try again. */
export function retry() {
  if (kept.failedLoad?.project !== get().current?.id) return false
  kept.failedLoad = null
  setError(null)
  return true
}

/** Loads the open project's chat, with the changes that arrived while it loaded. */
export async function load() {
  const project = get().current?.id
  if (project === undefined) return
  const request = switches
  const load = ++loads
  const failed = kept.failedLoad
  kept.failedLoad = null
  try {
    const opened = await sidecar('chat.open', { project })
    if (request !== switches || load !== loads) return
    set(({ error }) => ({ view: kept.early.reduce(merge, opened), error: failed !== null && error === failed.message ? null : error }))
    kept.early = []
    kept.loaded = project
  } catch (err) {
    if (request !== switches || load !== loads) return
    const message = String(err)
    kept.failedLoad = { project, message }
    setError(message)
  }
}

export const openFile = (rel: string | null) => set(rel === null ? { selected: null } : { selected: rel, panelView: viewOf(rel) })

export const setPanelView = (panelView: PanelView) => set({ panelView })

async function refreshFiles(project: string) {
  const files = await studio.files(project)
  if (project !== get().current?.id) return
  const shown = panelFiles(files)
  const latest = shown.latest?.modifiedMs ?? 0
  if (kept.lastSeen === null) {
    kept.lastSeen = latest
    set(({ panelView }) => ({ files, panelView: panelView ?? firstView(shown) }))
  } else if (shown.latest && latest > kept.lastSeen) {
    kept.lastSeen = latest
    set({ files, selected: null, panelView: viewOf(shown.latest.rel) })
  } else {
    set({ files })
  }
}

function heardReady(version: string) {
  // An engine that started again holds its own turns, so its status read replaces what the old run's events said. It
  // also holds what a crash cut off from the window, such as a turn's last entry, so the open chat is read again. The
  // changes that arrive meanwhile are kept, as when it first opened.
  kept.runs = {}
  set({ status: withRuns() })
  readStatus()
  if (get().current !== null) {
    kept.loaded = null
    kept.early = []
    void load()
  }
  kept.engineChanged = true
  set({ engine: `Engine ${version}` })
  // A check that failed while the engine started again is asked again, so Send does not stay off.
  checkReady()
  loadModels()
  for (const wake of kept.readyWaiters.splice(0)) wake()
  if (kept.saved !== null && !kept.saved.taken) readState(kept.saved)
}

function heardChat(event: ChatView) {
  const before = kept.runs[event.project]
  if (newer(before, event.seq)) {
    kept.runs = { ...kept.runs, [event.project]: { running: event.running, seq: event.seq } }
    // A turn that starts or ends moves its row at once, and reads the status again for the files it wrote and its last
    // activity. A transcript line that changes nothing reads nothing.
    if (before?.running !== event.running) {
      set({ status: withRuns() })
      readStatus()
    }
  }
  if (event.project !== get().current?.id) return
  if (kept.loaded !== event.project) kept.early.push(event)
  else set(({ view }) => ({ view: view && merge(view, event) }))
}

function heardLogin(event: LoginEvent) {
  switch (event.step) {
    case 'open':
      void openUrl(event.url).catch((err: unknown) => setError(String(err)))
      set({ signIn: event.code === undefined ? null : event })
      break
    case 'ask':
      set({ signIn: event })
      break
    case 'done':
      set({ signIn: null })
      checkReady()
      loadModels()
      readLogins()
      break
    case 'failed':
      set({ signIn: null })
      setError(event.detail)
      break
  }
}

function hear(event: SidecarEvent) {
  switch (event.type) {
    case 'ready':
      return heardReady(event.version)
    case 'engine':
      kept.engineChanged = true
      return set({ engine: event.state === 'stopped' ? event.detail : 'Engine restarting' })
    case 'login':
      return heardLogin(event)
    case 'chat':
      return heardChat(event)
  }
}

/**
 * Feeds the store while the window is open: sidecar events, a status read each time `projects` changes, and the open
 * project's files. A window that opens again starts from a clean store.
 */
export function useStudioEvents(projects: Project[]) {
  useEffect(() => {
    reset()
    set(EMPTY)
    const events = onSidecarEvent(hear)
    kept.events = events
    return () => {
      events.stop()
      reset()
    }
  }, [])

  useEffect(readStatus, [projects])

  const current = useStudio((s) => s.current)
  const running = useStudio((s) => s.view?.running ?? false)
  // While the agent works, new files show up within a couple of seconds.
  useEffect(() => {
    if (current === null) return
    const refresh = () => void refreshFiles(current.id).catch((err: unknown) => setError(String(err)))
    refresh()
    if (!running) return
    const timer = window.setInterval(refresh, 1500)
    return () => window.clearInterval(timer)
  }, [current, running])
}
