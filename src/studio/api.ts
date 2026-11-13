import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Method, Methods, Plate, SidecarEvent } from '../../sidecar/src/protocol'

/** The window's one call into the sidecar. A call made while it starts waits for it. */
export const sidecar = <M extends Method>(method: M, params: Methods[M]['params']) =>
  invoke<Methods[M]['result']>('sidecar', { method, params })

export const onSidecarEvent = (handler: (event: SidecarEvent) => void) =>
  listen<SidecarEvent>('sidecar://event', ({ payload }) => handler(payload))

/**
 * Rust asks for this as the app quits or the window closes. The window says at once that it is saving, so Rust holds
 * the quit for as long as that takes. Then it says it is done, or that a draft could not be saved, which calls the
 * quit off.
 */
export const onQuitFlush = (save: () => Promise<void>) =>
  listen('studio://flush', () => {
    void invoke('studio_flush_started')
    void save().then(
      () => invoke('studio_flushed'),
      () => invoke('studio_flush_failed'),
    )
  })

/** Opens the macOS setting that lets the app read Documents. */
export const openFilesPrivacy = () => invoke<void>('studio_open_files_privacy')

/** The folder projects live in, as Rust resolves it. */
export const projectsFolder = () => invoke<string>('studio_projects_folder')

/** The Bambu Studio the slice step would use: its version, none at all, or why the one found cannot be used. */
export type SlicerCheck = { found: 'ready'; version: string } | { found: 'none' } | { found: 'other'; detail: string }

/** Looks for the Bambu Studio the slice step uses. */
export const checkSlicer = () => invoke<SlicerCheck>('studio_slicer')

/** What a 3MF says about its print, as Rust reads it from the file. A field the file does not hold is absent. */
export interface PrintInfo {
  /** The printer model without the maker's name, as in `P2S`. */
  printer?: string
  /** The filament presets the slice used, as in `PETG Basic`. */
  filaments: string[]
  layerHeightMm?: number
  printSeconds?: number
  filamentGrams?: number
}

export interface ProjectFile {
  rel: string
  size: number
  modifiedMs: number
  /** Only a 3MF has one. */
  print?: PrintInfo
}

/**
 * A preset by the name Bambu Studio shows. `system` is the Bambu Lab preset a slice can run with: the same name, or for
 * a preset the person made, the one it was made from. It is `null` for a preset the person made from nothing.
 */
export interface BambuPreset {
  name: string
  system: string | null
}

/**
 * What the person last used in Bambu Studio. `printer` and `nozzle` are the two parts of the printer preset's name,
 * as in `Bambu Lab P2S` and `0.4`. Bambu Studio may have recorded no quality (`process`), filament, or plate.
 */
export interface BambuLastUsed {
  printer: string
  nozzle: string
  machine: BambuPreset
  process: BambuPreset | null
  filament: BambuPreset | null
  plate: Plate | null
}

/** The project folder's own files, and Bambu Studio's settings: the native edges Rust keeps. */
export const studio = {
  /** `null` when Bambu Studio has never run on this computer, or its last printer is not a Bambu Lab one. */
  bambuLastUsed: () => invoke<BambuLastUsed | null>('bambu_last_used'),
  files: (project: string) => invoke<ProjectFile[]>('studio_files', { project }),
  saveBytes: (project: string, name: string, bytes: Uint8Array) =>
    invoke<string>('studio_save_bytes', bytes, { headers: { 'm3d-project': project, 'm3d-name': encodeURIComponent(name) } }),
  reveal: (project: string, rel: string) => invoke<void>('studio_reveal', { project, rel }),
  openInBambu: (project: string, rel: string) => invoke<void>('studio_open_in_bambu', { project, rel }),
  popOut: (project: string, rel: string, version: number) => invoke<void>('studio_pop_out', { project, rel, version }),
  fileVersion: (project: string, rel: string) => invoke<number>('studio_file_version', { project, rel }),
}

/**
 * A project file as served by the app's `m3dfile://` protocol. Each project is its own host, so a preview page
 * can read only its own project. The version busts the cache when the file changes.
 */
export function fileUrl(project: string, rel: string, version?: number): string {
  const url = `m3dfile://${project}/${rel.split('/').map(encodeURIComponent).join('/')}`
  return version === undefined ? url : `${url}?v=${version}`
}

export const isMac = navigator.userAgent.includes('Mac')

export type FileKind = 'html' | 'model' | 'image' | 'text' | 'other'

export function fileKind(rel: string): FileKind {
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'html' || ext === 'htm') return 'html'
  if (['stl', '3mf', 'glb', 'gltf'].includes(ext)) return 'model'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return 'image'
  if (['json', 'py', 'txt', 'md', 'scad', 'csv'].includes(ext)) return 'text'
  return 'other'
}

export const is3mf = (rel: string) => rel.toLowerCase().endsWith('.3mf')

/** The right panel's views, in the order its tabs show them. */
export const VIEWS = ['guide', 'model', 'drawing', 'files'] as const
export type PanelView = (typeof VIEWS)[number]

/**
 * The view a file opens in. The agent names assembly guides `guide*.html` and drawings `drawing*.html`, at the top of
 * the project folder. Every other file opens from Files.
 */
export function viewOf(rel: string): PanelView {
  const name = rel.toLowerCase()
  if (!name.includes('/') && fileKind(rel) === 'html') {
    if (name.startsWith('guide')) return 'guide'
    if (name.startsWith('drawing')) return 'drawing'
  }
  return fileKind(rel) === 'model' ? 'model' : 'files'
}

/**
 * What the panel shows by default: the newest guide, model, and drawing the agent wrote, and its print files, newest
 * first. Files in `refs/` are the person's own, so none of these come from there. A model is the newest STL, GLB, or
 * glTF, and the newest 3MF only when there is none, as a 3MF is a print file. `latest` is the newest guide, drawing,
 * or model that is not a print file: a newer one than the panel has seen takes the panel over.
 */
export function panelFiles(files: ProjectFile[]) {
  const agents = files.filter((f) => !f.rel.startsWith('refs/')).sort((a, b) => b.modifiedMs - a.modifiedMs)
  const shows = agents.filter((f) => viewOf(f.rel) !== 'files' && !is3mf(f.rel))
  const newest = (view: PanelView) => shows.find((f) => viewOf(f.rel) === view)
  const prints = agents.filter((f) => is3mf(f.rel))
  return { guide: newest('guide'), model: newest('model') ?? prints[0], drawing: newest('drawing'), prints, latest: shows[0] }
}
export type PanelFiles = ReturnType<typeof panelFiles>

/** The view a project opens on: Guide when it has a guide, or else the first view with something to show. */
export function firstView(shown: PanelFiles): PanelView {
  return (['guide', 'model', 'drawing'] as const).find((view) => shown[view] !== undefined) ?? 'files'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
