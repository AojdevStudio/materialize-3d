import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Method, Methods, SidecarEvent } from '../../sidecar/src/protocol'

/** The window's one call into the sidecar. A call made while it starts waits for it. */
export const sidecar = <M extends Method>(method: M, params: Methods[M]['params']) =>
  invoke<Methods[M]['result']>('sidecar', { method, params })

export const onSidecarEvent = (handler: (event: SidecarEvent) => void) =>
  listen<SidecarEvent>('sidecar://event', ({ payload }) => handler(payload))

/** Rust asks for this as the app quits or the window closes: save the draft now, then say it is done. */
export const onQuitFlush = (save: () => Promise<void>) =>
  listen('studio://flush', () => void save().finally(() => invoke('studio_flushed')))

/** Opens the macOS setting that lets the app read Documents. */
export const openFilesPrivacy = () => invoke<void>('studio_open_files_privacy')

export interface ProjectFile {
  rel: string
  size: number
  modifiedMs: number
}

/** The project folder's own files: the native edges Rust keeps. */
export const studio = {
  files: (project: string) => invoke<ProjectFile[]>('studio_files', { project }),
  saveBytes: (project: string, name: string, bytes: Uint8Array) =>
    invoke<string>('studio_save_bytes', bytes, { headers: { 'm3d-project': project, 'm3d-name': encodeURIComponent(name) } }),
  reveal: (project: string, rel: string) => invoke<void>('studio_reveal', { project, rel }),
  openInBambu: (project: string, rel: string) => invoke<void>('studio_open_in_bambu', { project, rel }),
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

/** Files that open in the preview on their own when the agent writes them. Ossie's own pictures in refs/ do not. */
export function autoOpens(rel: string): boolean {
  const kind = fileKind(rel)
  return !rel.startsWith('refs/') && (kind === 'html' || kind === 'model' || kind === 'image')
}

export const is3mf = (rel: string) => rel.toLowerCase().endsWith('.3mf')

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
