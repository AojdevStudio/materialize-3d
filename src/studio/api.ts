import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { Method, Methods, SidecarEvent } from '../../sidecar/src/protocol'
import type { BambuLastUsed, PrinterChoice, ProjectFile, SlicerCheck, UpdateCheck, UpdateProgress } from './native-types'

export type {
  BambuLastUsed,
  BambuPreset,
  PrintInfo,
  PrinterChoice,
  ProjectFile,
  SlicerCheck,
  UpdateCheck,
  UpdateProgress,
} from './native-types'

/** Every Rust command the window calls. `acl_tests` in `src-tauri/src/lib.rs` holds this list equal to Rust's. */
const COMMANDS = [
  'sidecar',
  'update_check',
  'update_install',
  'studio_files',
  'studio_reveal',
  'studio_open_in_bambu',
  'studio_pop_out',
  'studio_file_version',
  'studio_projects_folder',
  'studio_slicer',
  'studio_flush_started',
  'studio_flush_failed',
  'studio_flushed',
  'studio_open_files_privacy',
  'bambu_last_used',
  'studio_printers',
] as const

const call = <T>(command: (typeof COMMANDS)[number], ...args: [InvokeArgs?]) => invoke<T>(command, ...args)

/** Every event Rust sends the window, with what it carries. A test in `src-tauri/src/studio/window.rs` checks the names. */
export interface Events {
  'sidecar://event': SidecarEvent
  'studio://flush': null
  'update:progress': UpdateProgress
  'update:waiting': number
}

/** A listener that hears Rust once `ready` settles. `stop` ends it, also before then. */
export interface Listening {
  ready: Promise<void>
  stop: () => void
}

function listening(subscribed: Promise<UnlistenFn>): Listening {
  let stopped = false
  let unlisten: UnlistenFn | undefined
  const ready = subscribed.then((teardown) => {
    if (stopped) teardown()
    else unlisten = teardown
  })
  return {
    ready,
    stop: () => {
      stopped = true
      unlisten?.()
    },
  }
}

/** The window's one way to hear an event from Rust. */
export const listenTo = <E extends keyof Events>(event: E, handler: (payload: Events[E]) => void) =>
  listening(listen<Events[E]>(event, ({ payload }) => handler(payload)))

/** The window's one call into the sidecar. A call made while it starts waits for it. */
export const sidecar = <M extends Method>(method: M, params: Methods[M]['params']) =>
  call<Methods[M]['result']>('sidecar', { method, params })

export const onSidecarEvent = (handler: (event: SidecarEvent) => void) => listenTo('sidecar://event', handler)

/**
 * Rust asks for this as the app quits or the window closes. The window says at once that it is saving, so Rust holds
 * the quit for as long as that takes. Then it says it is done, or that a draft could not be saved, which calls the
 * quit off.
 */
export const onQuitFlush = (save: () => Promise<void>) =>
  listenTo('studio://flush', () => {
    void call('studio_flush_started')
    void save().then(
      () => call('studio_flushed'),
      () => call('studio_flush_failed'),
    )
  })

/** Files dropped anywhere on the window, by path. */
export const onFileDrop = (handler: (paths: string[]) => void) =>
  listening(
    getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'drop') handler(payload.paths)
    }),
  )

export const updater = {
  check: () => call<UpdateCheck>('update_check'),
  /** On success Rust restarts the app, so this returns only on failure. */
  install: (version: string) => call<void>('update_install', { version }),
}

/** Opens the macOS setting that lets the app read Documents. */
export const openFilesPrivacy = () => call<void>('studio_open_files_privacy')

/** The folder projects live in. Rust makes it when missing. */
export const projectsFolder = () => call<string>('studio_projects_folder')

/** Looks for the Bambu Studio the slice step uses. */
export const checkSlicer = () => call<SlicerCheck>('studio_slicer')

/** The project folder's own files, and Bambu Studio's settings: the native edges Rust keeps. */
export const studio = {
  /** `null` when Bambu Studio has never run on this computer, or its last printer is not a Bambu Lab one. */
  bambuLastUsed: () => call<BambuLastUsed | null>('bambu_last_used'),
  /** Fails when the validated Bambu Studio is not installed. */
  printers: () => call<PrinterChoice[]>('studio_printers'),
  files: (project: string) => call<ProjectFile[]>('studio_files', { project }),
  reveal: (project: string, rel: string) => call<void>('studio_reveal', { project, rel }),
  openInBambu: (project: string, rel: string) => call<void>('studio_open_in_bambu', { project, rel }),
  popOut: (project: string, rel: string, version: number) => call<void>('studio_pop_out', { project, rel, version }),
  fileVersion: (project: string, rel: string) => call<number>('studio_file_version', { project, rel }),
}

/** The scheme Rust serves project files on. A test in `src-tauri/src/studio/window.rs` checks it. */
const FILE_SCHEME = 'm3dfile'

/**
 * A project file as served by the app's `m3dfile://` protocol. Each project is its own host, so a preview page
 * can read only its own project. The version busts the cache when the file changes.
 */
export function fileUrl(project: string, rel: string, version?: number): string {
  const url = `${FILE_SCHEME}://${project}/${rel.split('/').map(encodeURIComponent).join('/')}`
  return version === undefined ? url : `${url}?v=${version}`
}
