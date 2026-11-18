/** A project folder as the sidebar sees it. */
import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SKIPPED } from './protocol'

/** Whether the file list skips a folder or file of this name. Rust's file list skips the same names. */
export const skipped = (name: string) => name.startsWith('.') || SKIPPED.some((skip) => skip === name)

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
