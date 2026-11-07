import { describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, ChatView } from '../src/protocol'
import { spawnSidecar } from './sidecar'

const LEGACY = join(import.meta.dir, 'fixtures', 'legacy')

describe('chats from before the store', () => {
  test('are imported once, as they were, and their files stay as they are', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-import-'))
    const projects = join(dir, 'projects')
    cpSync(LEGACY, projects, { recursive: true })
    const transcript = join(projects, '2026-11-06-a-wall-clip', '.m3d', 'transcript.jsonl')
    const before = readFileSync(transcript)

    const first = spawnSidecar(join(dir, 'state'), projects)
    await first.next()
    const state = (await first.call('state.get')) as { projects: { id: string; title: string }[] }
    expect(state.projects).toEqual([expect.objectContaining({ id: '2026-11-06-a-wall-clip', title: 'A wall clip for my cable', createdMs: 1794000000000 })])
    const view = (await first.call('chat.open', { project: '2026-11-06-a-wall-clip' })) as ChatView
    const shown = view.entries.map(({ id: _, ...entry }) => entry)
    expect(shown).toEqual([
      { kind: 'imported', role: 'user', text: 'A wall clip for my cable', images: ['refs/cable.jpg'] },
      { kind: 'imported', role: 'tool', name: 'Bash', text: 'Build the clip', result: 'clip.stl written', failed: false },
      { kind: 'imported', role: 'assistant', text: 'The clip is in clip.stl.' },
      { kind: 'imported', role: 'user', text: 'Make it thicker', images: [] },
      { kind: 'imported', role: 'assistant', text: 'The turn stopped: This turn stopped when the app closed.' },
    ])
    await first.quit()

    const second = spawnSidecar(join(dir, 'state'), projects)
    await second.next()
    expect(((await second.call('state.get')) as { projects: unknown[] }).projects).toHaveLength(1)
    expect(((await second.call('chat.open', { project: '2026-11-06-a-wall-clip' })) as ChatView).entries).toEqual(view.entries)
    await second.quit()
    expect(readFileSync(transcript).equals(before)).toBe(true)
    expect(existsSync(join(projects, '2026-11-06-a-wall-clip', '.m3d', 'project.json'))).toBe(true)
  })
})

describe('the update gate', () => {
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-gate-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
    chmodSync(join(bin, 'uv'), 0o755)
    return { data: join(dir, 'state'), projects: join(dir, 'projects'), env: { PATH: `${bin}:${process.env.PATH}` } }
  }

  test('holds the pass from before a turn commits until its work is done, and a send is refused while an update installs', async () => {
    const where = scratch()
    const app = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
    await app.next()
    await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.open', { project })
    expect(app.gate.requests).toEqual([])

    await app.call('chat.send', { project, requestId: 'r1', text: 'please wait', attachments: [] })
    expect(app.gate.requests).toEqual([true])
    const started = join(where.projects, project, 'started')
    while (!existsSync(started)) await Bun.sleep(25)
    expect(app.gate.requests).toEqual([true])
    writeFileSync(join(where.projects, project, 'go'), '')
    await app.until((event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant'))
    while (app.gate.requests.at(-1) !== false) await Bun.sleep(25)
    expect(app.gate.requests).toEqual([true, false])

    app.gate.installing = true
    await app.call('drafts.set', { key: project, text: 'make it red', attachments: [] })
    await expect(app.call('chat.send', { project, requestId: 'r2', text: 'make it red', attachments: [] })).rejects.toThrow('An update is installing.')
    const view = (await app.call('chat.open', { project })) as ChatView
    expect(view.entries.filter((entry) => entry.kind === 'user')).toHaveLength(1)
    expect(((await app.call('state.get')) as { drafts: Record<string, unknown> }).drafts[project]).toEqual({ text: 'make it red', attachments: [] })
    await app.quit()
  })
})
