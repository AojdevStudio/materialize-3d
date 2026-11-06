import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface Project {
  id: string
  title: string
  createdMs: number
  path: string
}

export interface ProjectFile {
  rel: string
  size: number
  modifiedMs: number
}

/** One line of the project transcript: a Claude Code stream-json event, or one of the app's own `m3d_*` events. */
export type StudioEvent = { type: string } & Record<string, unknown>

export const studio = {
  projects: () => invoke<Project[]>('studio_projects'),
  createProject: (title: string) => invoke<Project>('studio_create_project', { title }),
  transcript: (project: string) => invoke<StudioEvent[]>('studio_transcript', { project }),
  send: (project: string, text: string, images: string[]) => invoke<void>('studio_send', { project, text, images }),
  cancel: (project: string) => invoke<void>('studio_cancel', { project }),
  files: (project: string) => invoke<ProjectFile[]>('studio_files', { project }),
  importFile: (project: string, source: string) => invoke<string>('studio_import_file', { project, source }),
  saveBytes: (project: string, name: string, bytes: Uint8Array) =>
    invoke<string>('studio_save_bytes', bytes, { headers: { 'm3d-project': project, 'm3d-name': encodeURIComponent(name) } }),
  reveal: (project: string, rel: string) => invoke<void>('studio_reveal', { project, rel }),
  openInBambu: (project: string, rel: string) => invoke<void>('studio_open_in_bambu', { project, rel }),
  /** `seq` is the event's line in the project transcript, so history and live events join without gaps or repeats. */
  onEvent: (handler: (project: string, seq: number, event: StudioEvent) => void) =>
    listen<{ project: string; seq: number; event: StudioEvent }>('studio://event', ({ payload }) => handler(payload.project, payload.seq, payload.event)),
}

const isWindows = navigator.userAgent.includes('Windows')

/**
 * A project file as served by the app's `m3dfile://` protocol. Each project is its own host, so a preview page
 * can read only its own project. The version busts the cache when the file changes.
 */
export function fileUrl(project: string, rel: string, version?: number): string {
  const path = rel.split('/').map(encodeURIComponent).join('/')
  const url = isWindows ? `http://m3dfile.localhost/${encodeURIComponent(project)}/${path}` : `m3dfile://${project}/${path}`
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
