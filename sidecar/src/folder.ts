/** A project folder as the sidebar sees it, and the model files a paired phone can list and read in it. */
import { closeSync, constants, createReadStream, type Dirent, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { Readable } from 'node:stream'
import { type ModelFile, SKIPPED } from './protocol'

/** Whether the file list skips a folder or file of this name. Rust's file list skips the same names. */
export const skipped = (name: string) => name.startsWith('.') || SKIPPED.some((skip) => skip === name)

/** The model files a phone can list and read, by extension, with the content type each is sent as. */
const MODEL_TYPES: Record<string, string> = { '.stl': 'model/stl', '.3mf': 'model/3mf', '.glb': 'model/gltf-binary' }

/**
 * What a project's folder holds for the sidebar: its `.3mf` files outside `refs/`, where the person's own files go,
 * and when a file in it last changed. Folders the file list skips are skipped here too. A folder not made yet is empty.
 */
export function folderSummary(root: string): { printFiles: number; newestMs: number } {
  const summary = { printFiles: 0, newestMs: 0 }
  if (!existsSync(root)) return summary
  const walk = (dir: string, refs: boolean) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // The agent may remove a folder while it is read. A folder that is gone holds nothing to count.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (skipped(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, refs || (dir === root && entry.name === 'refs'))
      else if (entry.isFile()) {
        // Likewise a file removed since the folder was read.
        const stat = statSync(path, { throwIfNoEntry: false })
        if (stat === undefined) continue
        summary.newestMs = Math.max(summary.newestMs, stat.mtimeMs)
        if (!refs && entry.name.toLowerCase().endsWith('.3mf')) summary.printFiles++
      }
    }
  }
  walk(root, false)
  return summary
}

/**
 * A chat's folder where it really is: `unmade` before the agent made it, and `link` when the folder is a link, which
 * is refused, so the files a phone lists and reads stay under the projects folder.
 */
function chatFolder(projectsDir: string, id: string): { real: string } | 'unmade' | 'link' {
  const folder = join(projectsDir, id)
  if (!existsSync(folder)) return 'unmade'
  const real = join(realpathSync.native(projectsDir), id)
  return realpathSync.native(folder) === real ? { real } : 'link'
}

/**
 * The model files in a chat's folder, newest first, or undefined when the folder is a link. A folder not made yet has
 * none. Names the file list skips, and links, are left out.
 */
export function modelFiles(projectsDir: string, id: string): ModelFile[] | undefined {
  const folder = chatFolder(projectsDir, id)
  if (folder === 'link') return undefined
  if (folder === 'unmade') return []
  const files: ModelFile[] = []
  // A folder is read, and a file measured, only while its real path is the one its name spells, so a folder swapped for
  // a link during the walk is passed over, not followed. One removed meanwhile is passed over too.
  const here = (path: string) => {
    try {
      return realpathSync.native(path) === path
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }
  const walk = (dir: string, rel: string) => {
    if (!here(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skipped(entry.name)) continue
      const path = join(dir, entry.name)
      const name = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(path, name)
      else if (entry.isFile() && MODEL_TYPES[extname(entry.name).toLowerCase()] !== undefined) {
        const found = lstatSync(path, { throwIfNoEntry: false })
        if (found?.isFile() === true && here(path)) files.push({ rel: name, size: found.size, modifiedMs: found.mtimeMs })
      }
    }
  }
  walk(folder.real, '')
  return files.sort((a, b) => b.modifiedMs - a.modifiedMs)
}

/**
 * The bytes of one model file that `modelFiles` lists, by its `rel`, with its content type. Undefined for anything
 * else: a folder not made or that is a link, a name the file list skips, a file that is not a model, one outside the
 * folder, or one reached through a link.
 */
export function openModelFile(projectsDir: string, id: string, rel: string): { bytes: ReadableStream<Uint8Array>; type: string } | undefined {
  const folder = chatFolder(projectsDir, id)
  const type = MODEL_TYPES[extname(rel).toLowerCase()]
  if (typeof folder === 'string' || type === undefined || rel.split('/').some(skipped)) return undefined
  const named = join(folder.real, rel)
  try {
    // The list leaves links out, so a read takes only a regular file inside the folder whose name spells its real path.
    // A `..` part is already a skipped name, so the inside check guards the same rule a second way, as `inside` in chat.ts does.
    if (!named.startsWith(`${folder.real}${sep}`) || realpathSync.native(named) !== named || !statSync(named).isFile()) return undefined
  } catch {
    return undefined
  }
  // The bytes stream from the file opened here, checked to be the one named, so a swap after the check serves
  // nothing, and a large model is never held in memory whole. The stream closes the file when it ends.
  // Opened without waiting, so a pipe put in the file's place cannot hold the sidecar before the check refuses it.
  const fd = openSync(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let same: boolean
  try {
    const opened = fstatSync(fd)
    const there = lstatSync(named)
    same = opened.isFile() && opened.ino === there.ino && opened.dev === there.dev && realpathSync.native(named) === named
  } catch (error) {
    closeSync(fd)
    throw error
  }
  if (!same) {
    closeSync(fd)
    return undefined
  }
  return { bytes: Readable.toWeb(createReadStream(named, { fd })) as ReadableStream<Uint8Array>, type }
}
