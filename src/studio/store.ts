import { useEffect } from 'react'
import { create } from 'zustand'
import type { ChatView, Project, ProjectStatus, SidecarEvent } from '../../sidecar/src/protocol'
import { onSidecarEvent, sidecar, studio, type ProjectFile } from './api'
import { firstView, panelFiles, viewOf, type PanelView } from './files'

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
}

const EMPTY: StudioState = { current: null, view: null, files: [], selected: null, panelView: null, status: {}, error: null }

/**
 * The window's one store for chats and project status. Every chat event lands here once, ordered by `seq`, and the chat,
 * the sidebar, and the start screen read it. `useStudioEvents` feeds it while the window is open.
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
  return { ...view, entries, running: change.running, waiting: change.waiting, turn: change.turn, seq: change.seq }
}

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
}

const fresh = (): Kept => ({ read: {}, runs: {}, reading: { busy: false, again: false }, loaded: null, early: [], failedLoad: null, lastSeen: null })

let kept = fresh()
/** Bumped on every switch and every reset, so a slow load for a project already left is dropped. */
let switches = 0

function reset() {
  kept = fresh()
  switches += 1
}
/** Counts chat loads, so only the newest load of the open chat replaces its view, not an older one that answers late. */
let loads = 0

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

/** Opens a file in the panel's view for it. Null goes back to the list of files. */
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

function hear(event: SidecarEvent) {
  if (event.type === 'ready') {
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
    return
  }
  if (event.type !== 'chat') return
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

/**
 * Feeds the store while the window is open: chat events, a status read each time `projects` changes, and the open
 * project's files. A window that opens again starts from a clean store.
 */
export function useStudioEvents(projects: Project[]) {
  useEffect(() => {
    reset()
    set(EMPTY)
    const events = onSidecarEvent(hear)
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
