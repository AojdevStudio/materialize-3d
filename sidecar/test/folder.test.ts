import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { folderSummary, modelFiles, openModelFile } from '../src/folder'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'm3d-summary-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Writes a file in the project, last changed at `seconds` since 1970. */
function put(project: string, rel: string, seconds: number) {
  const path = join(dir, 'projects', project, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  utimesSync(path, seconds, seconds)
}

describe('folderSummary', () => {
  test('counts .3mf files outside the top refs/ folder, and skips hidden and tool folders entirely', () => {
    const project = '2026-11-17-clip'
    put(project, 'clip.3mf', 1_000)
    put(project, 'print/clip-b.3MF', 2_000)
    put(project, 'sub/refs/kept.3mf', 3_000)
    put(project, 'notes.txt', 4_000)
    put(project, 'refs/deep/theirs.3mf', 4_500)
    put(project, 'refs/theirs.3mf', 5_000)
    for (const skipped of ['.m3d/chat.3mf', '.hidden.3mf', '__pycache__/a.3mf', 'node_modules/b.3mf', 'venv/c.3mf', 'print/.cache/d.3mf']) {
      put(project, skipped, 9_000)
    }
    expect(folderSummary(join(dir, 'projects', project))).toEqual({ printFiles: 3, newestMs: 5_000_000 })
  })

  test('a folder not made yet is empty', () => {
    expect(folderSummary(join(dir, 'projects', '2026-11-17-not-made'))).toEqual({ printFiles: 0, newestMs: 0 })
  })
})

describe('model files', () => {
  /** A chat folder with model files, other files, links, and app records in it, under its own projects folder. */
  function chatWithFiles() {
    const root = mkdtempSync(join(dir, 'models-'))
    const projects = join(root, 'projects')
    const id = '2026-11-24-bracket'
    const folder = join(projects, id)
    mkdirSync(join(folder, 'print'), { recursive: true })
    mkdirSync(join(folder, '.m3d'))
    writeFileSync(join(folder, 'part.STL'), 'solid part')
    utimesSync(join(folder, 'part.STL'), 1_000, 1_000)
    writeFileSync(join(folder, 'print', 'plate.3mf'), 'PK3mf')
    writeFileSync(join(folder, 'notes.txt'), 'not a model')
    writeFileSync(join(folder, '.m3d', 'hidden.stl'), 'the app records')
    writeFileSync(join(projects, 'escape.stl'), 'outside the chat')
    writeFileSync(join(root, 'outside.stl'), 'outside the projects')
    symlinkSync(join(root, 'outside.stl'), join(folder, 'linked.stl'))
    // Links that stay in the chat but name a model: one to the app records, one to a file that is not a model.
    symlinkSync(join(folder, '.m3d', 'hidden.stl'), join(folder, 'records.stl'))
    symlinkSync(join(folder, 'notes.txt'), join(folder, 'notes.glb'))
    return { root, projects, id, folder }
  }

  const read = async (projects: string, id: string, rel: string) => {
    const file = openModelFile(projects, id, rel)
    return file === undefined ? undefined : { type: file.type, text: await new Response(file.bytes).text() }
  }

  test('lists only real model files, newest first, and reads each with its type', async () => {
    const { projects, id } = chatWithFiles()
    const files = modelFiles(projects, id)
    expect(files?.map((file) => file.rel)).toEqual(['print/plate.3mf', 'part.STL'])
    expect(files?.[1]).toEqual({ rel: 'part.STL', size: 'solid part'.length, modifiedMs: 1_000_000 })
    expect(await read(projects, id, 'print/plate.3mf')).toEqual({ type: 'model/3mf', text: 'PK3mf' })
    expect(await read(projects, id, 'part.STL')).toEqual({ type: 'model/stl', text: 'solid part' })
  })

  test('reads no file outside the chat, through a link, in the app records, or that is not a model', async () => {
    const { projects, id } = chatWithFiles()
    for (const rel of ['../escape.stl', '../../outside.stl', 'linked.stl', 'records.stl', 'notes.glb', '.m3d/hidden.stl', 'notes.txt', 'missing.stl', 'print']) {
      expect([rel, await read(projects, id, rel)]).toEqual([rel, undefined])
    }
  })

  test('a chat folder not made yet has no files, and one that became a link lists and reads nothing', async () => {
    const { root, projects, id, folder } = chatWithFiles()
    expect(modelFiles(projects, '2026-11-24-not-made')).toEqual([])
    expect(openModelFile(projects, '2026-11-24-not-made', 'part.STL')).toBeUndefined()
    renameSync(folder, join(root, 'moved'))
    symlinkSync(join(root, 'moved'), folder)
    expect(modelFiles(projects, id)).toBeUndefined()
    expect(openModelFile(projects, id, 'part.STL')).toBeUndefined()
  })
})
