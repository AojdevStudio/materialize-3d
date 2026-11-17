import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { createRegistry } from '@earendil-works/pi-durable'
import { Store } from '../src/store'

let dir: string
let store: Store

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'm3d-summary-'))
  store = await Store.open({
    dataDir: join(dir, 'state'),
    projectsDir: join(dir, 'projects'),
    models: createModels({ credentials: new InMemoryCredentialStore() }),
    registry: createRegistry(),
    env: () => {
      throw new Error('no conversation runs here')
    },
  })
})

afterAll(async () => {
  await store.close()
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
    expect(store.folderSummary(project)).toEqual({ printFiles: 3, newestMs: 5_000_000 })
  })

  test('a folder not made yet is empty', () => {
    expect(store.folderSummary('2026-11-17-not-made')).toEqual({ printFiles: 0, newestMs: 0 })
  })
})
