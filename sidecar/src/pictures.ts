/**
 * A draft's files, from the paste to the send. A pasted picture is kept in a folder of its own in the pictures folder,
 * outside every project, until a send copies the draft's files into its project, or its draft lets it go and the sweep
 * at start removes it.
 */
import { constants, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, link, rm } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { leaves } from './agent'
import type { Draft } from './protocol'
import { sendName } from './store'

/** Saves a pasted picture as `name` in a new folder of its own in `pictures`, and answers its path. */
export function savePicture(pictures: string, name: string, data: string): string {
  // Only a plain file name: the picture's folder is the sidecar's, not one the window names.
  if (basename(name) !== name || name.startsWith('.')) throw new Error(`${name} is not a picture's file name`)
  const folder = join(pictures, crypto.randomUUID())
  mkdirSync(folder, { recursive: true })
  const path = join(folder, name)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

/**
 * Removes the pasted pictures no draft in `kept` names. A window that outlived a crash may still hold one it has not
 * saved in a draft yet, so only pictures older than a day go.
 */
export function sweepPictures(pictures: string, kept: readonly Draft[]): void {
  const named = new Set(kept.flatMap((draft) => draft.attachments))
  const dayAgo = Date.now() - 86_400_000
  for (const folder of existsSync(pictures) ? readdirSync(pictures) : []) {
    const path = join(pictures, folder)
    // Anything here that is not a picture's folder, as a file Finder leaves or a link, is not the sidecar's, so it is
    // read without following it.
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.mtimeMs > dayAgo) continue
    if (!readdirSync(path).some((file) => named.has(join(path, file)))) rmSync(path, { recursive: true, force: true })
  }
}

/**
 * What one `copyAttachments` call made in `refs/draft-<rev>`: each file it wrote, by name with the inode it got, and
 * whether it made the folder. The inode tells a file this call wrote from one put there in its place since.
 */
export type Made = { rev: number; files: { name: string; ino: bigint }[]; folder: boolean }

/**
 * Copies a draft's files into the project, as `refs/draft-<rev>/<name>`, and answers those paths and what this call
 * made. Each copy is written beside its place and then linked into it, so a send of the same revision again, as after
 * a crash or a refused send, finds every finished copy and makes no second one.
 */
export async function copyAttachments(folder: string, rev: number, sources: string[]): Promise<{ copied: string[]; made: Made }> {
  const made: Made = { rev, files: [], folder: false }
  if (sources.length === 0) return { copied: [], made }
  const rel = join('refs', sendName(rev))
  const dir = join(folder, rel)
  // The agent could have made either folder a link. Files land inside the project or nowhere, so each folder is
  // checked before anything is made in it.
  const check = (path: string) => {
    if (leaves(relative(realpathSync.native(folder), realpathSync.native(path)))) throw new Error('refs/ leads outside the project folder')
  }
  mkdirSync(join(folder, 'refs'), { recursive: true })
  check(join(folder, 'refs'))
  made.folder = mkdirSync(dir, { recursive: true }) !== undefined
  check(dir)
  const names = new Set<string>()
  const copied: string[] = []
  // One at a time, so each name is taken before the next is chosen. A copy runs off the event loop, as a model file
  // can be large.
  for (const source of sources) {
    const clean = basename(source).replace(/[^A-Za-z0-9._-]/g, '-')
    const file = clean.replace(/\./g, '') === '' ? 'picture.png' : clean
    const dot = file.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, '']
    // A Mac volume ignores case in names, so two files whose names differ only in case get two names.
    let name = file
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`
    names.add(name.toLowerCase())
    const target = join(dir, name)
    if (lstatSync(target, { throwIfNoEntry: false }) === undefined) {
      // A file that is gone can't be sent. Nor can one that is not regular, such as a pipe, which would hold the copy.
      if (statSync(source, { throwIfNoEntry: false })?.isFile() !== true) {
        throw new Error(`A file in this message can't be read: ${basename(source)}. Take it out and send again.`)
      }
      // Each copy has a part file of its own, so two sends of one revision at once, as a phone's retry, never share one.
      // Its name holds no file name, which can already be as long as a name may be.
      const part = join(dir, `.${crypto.randomUUID()}.part`)
      await copyFile(source, part, constants.COPYFILE_EXCL)
      // A link fails when the name is taken, so of two sends of one revision at once, only the first owns the copy.
      const linked = await link(part, target).then(
        () => true,
        (error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
          throw error
        },
      )
      await rm(part, { force: true })
      if (linked) made.files.push({ name, ino: lstatSync(target, { bigint: true }).ino })
    }
    copied.push(join(rel, name))
  }
  return { copied, made }
}

/**
 * Removes what one `copyAttachments` call made for a revision that never goes out: each file it wrote that is still
 * that file, then its folder once that is empty. A file it found there, or one put in its place since, stays. A folder
 * that leads outside the project is left alone.
 */
export function removeAttachments(folder: string, { rev, files, folder: madeFolder }: Made): void {
  const dir = join(folder, 'refs', sendName(rev))
  if (files.length === 0 || !existsSync(dir) || leaves(relative(realpathSync.native(folder), realpathSync.native(dir)))) return
  for (const { name, ino } of files) {
    const path = join(dir, name)
    if (lstatSync(path, { bigint: true, throwIfNoEntry: false })?.ino === ino) rmSync(path, { force: true })
  }
  if (madeFolder && readdirSync(dir).length === 0) rmdirSync(dir)
}
