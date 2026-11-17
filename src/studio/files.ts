import EXTENSIONS from './extensions.json'
import type { ProjectFile } from './native-types'

/**
 * How the window shows a file, by its extension. The lists are in `extensions.json`, which a test in
 * `src-tauri/src/studio/files.rs` holds Rust's served content types to.
 */
const KINDS = ['html', 'model', 'image', 'text'] as const satisfies readonly (keyof typeof EXTENSIONS)[]
export type FileKind = (typeof KINDS)[number] | 'other'

export const extensionOf = (rel: string) => rel.split('.').pop()?.toLowerCase() ?? ''

export function fileKind(rel: string): FileKind {
  const ext = extensionOf(rel)
  return KINDS.find((kind) => EXTENSIONS[kind].includes(ext)) ?? 'other'
}

export const is3mf = (rel: string) => rel.toLowerCase().endsWith('.3mf')

/** The last part of a path. */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** The sidecar saves the person's attachments in `refs/`. Every other file in a project is the agent's. */
export const isAgentFile = (rel: string) => !rel.startsWith('refs/')

/** The right panel's views, in the order its tabs show them. */
export const VIEWS = ['guide', 'model', 'drawing', 'files'] as const
export type PanelView = (typeof VIEWS)[number]

/**
 * The views that show a page the agent writes at the top of the project folder, named after the view. The agent prompt
 * (`sidecar/src/workflow.md`) tells the agent these names, and a test holds it to them.
 */
export const PAGE_VIEWS = ['guide', 'drawing'] as const

/** The view a file opens in. A file that is not a model or one of the agent's pages opens from Files. */
export function viewOf(rel: string): PanelView {
  const name = rel.toLowerCase()
  const page = !name.includes('/') && fileKind(rel) === 'html' ? PAGE_VIEWS.find((view) => name.startsWith(view)) : undefined
  return page ?? (fileKind(rel) === 'model' ? 'model' : 'files')
}

/**
 * What the panel shows by default: the newest guide, model, and drawing the agent wrote, and its print files, newest
 * first. A model is the newest STL, GLB, or glTF, and the newest 3MF only when there is none, as a 3MF is a print file.
 * `latest` is the newest guide, drawing, or model that is not a print file: a newer one than the panel has seen takes
 * the panel over.
 */
export function panelFiles(files: ProjectFile[]) {
  const agents = files.filter((f) => isAgentFile(f.rel)).sort((a, b) => b.modifiedMs - a.modifiedMs)
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
