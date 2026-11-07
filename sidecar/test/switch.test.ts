import { describe, expect, test } from 'bun:test'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

describe('a picture pasted into a draft', () => {
  test('is kept in a file of its own, outside any project, so the draft can keep it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-picture-'))
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'))
    await app.next()
    const path = (await app.call('drafts.picture', { name: 'pasted.png', data: Buffer.from('png bytes').toString('base64') })) as string
    expect(path.startsWith(dir)).toBe(true)
    expect(path.endsWith('pasted.png')).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('png bytes')
    await expect(app.call('drafts.picture', { name: '../escape.png', data: '' })).rejects.toThrow()
    await app.quit()
  })

  test('is removed at the next start once no draft keeps it, and kept while one does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-picture-'))
    const first = spawnSidecar(join(dir, 'state'), join(dir, 'projects'))
    await first.next()
    const kept = (await first.call('drafts.picture', { name: 'kept.png', data: '' })) as string
    const dropped = (await first.call('drafts.picture', { name: 'dropped.png', data: '' })) as string
    await first.call('drafts.set', { key: 'new', text: 'like this', attachments: [kept] })
    await first.quit()
    const second = spawnSidecar(join(dir, 'state'), join(dir, 'projects'))
    await second.next()
    expect(existsSync(kept)).toBe(true)
    // A picture from a moment ago may still wait in a window that outlived a crash, so only old ones go.
    expect(existsSync(dropped)).toBe(true)
    await second.quit()
    utimesSync(dirname(dropped), new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000))
    const third = spawnSidecar(join(dir, 'state'), join(dir, 'projects'))
    await third.next()
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(dropped)).toBe(false)
    await third.quit()
  })

  test('the cleanup at start passes over a file beside the picture folders, such as one Finder leaves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-picture-'))
    mkdirSync(join(dir, 'pictures'))
    const stray = join(dir, 'pictures', '.DS_Store')
    writeFileSync(stray, '')
    utimesSync(stray, new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 2 * 86_400_000))
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'))
    expect(await app.next()).toMatchObject({ kind: 'event', event: { type: 'ready' } })
    expect(existsSync(stray)).toBe(true)
    await app.quit()
  })

  test('the cleanup at start passes over a link to nothing in the pictures folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-picture-'))
    mkdirSync(join(dir, 'pictures'))
    symlinkSync(join(dir, 'gone'), join(dir, 'pictures', 'broken'))
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'))
    expect(await app.next()).toMatchObject({ kind: 'event', event: { type: 'ready' } })
    await app.quit()
  })
})

describe('the import of chats from before the store', () => {
  const CLIP = join(LEGACY, '2026-11-06-a-wall-clip')

  test('skips a project whose record cannot be read, and names it, and passes over a line that is not an event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-import-'))
    const projects = join(dir, 'projects')
    cpSync(CLIP, join(projects, '2026-11-06-bad-record'), { recursive: true })
    writeFileSync(join(projects, '2026-11-06-bad-record', '.m3d', 'project.json'), '{"title":')
    cpSync(CLIP, join(projects, '2026-11-06-null-line'), { recursive: true })
    const transcript = join(projects, '2026-11-06-null-line', '.m3d', 'transcript.jsonl')
    // Lines a cut-off or hand-edited transcript can hold: no event, content that is not a list, and a null block.
    const odd = ['null', '{"type":"assistant","message":{"content":{"text":"x"}}}', '{"type":"assistant","message":{"content":[null]}}']
    writeFileSync(transcript, `${odd.join('\n')}\n${readFileSync(transcript, 'utf8')}`)
    const app = spawnSidecar(join(dir, 'state'), projects)
    const state = (await app.call('state.get')) as { projects: { id: string }[] }
    expect(state.projects.map((p) => p.id)).toEqual(['2026-11-06-null-line'])
    expect(((await app.call('chat.open', { project: '2026-11-06-null-line' })) as ChatView).entries).toHaveLength(5)
    await app.quit()
    expect(await app.stderr()).toContain('2026-11-06-bad-record')
  })

  test('keeps a project that has no chat yet, and shows a step a quit cut off as stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-import-'))
    const projects = join(dir, 'projects')
    cpSync(CLIP, join(projects, '2026-11-06-no-chat'), { recursive: true })
    rmSync(join(projects, '2026-11-06-no-chat', '.m3d', 'transcript.jsonl'))
    cpSync(CLIP, join(projects, '2026-11-06-cut-off'), { recursive: true })
    const cut = [
      { type: 'm3d_user', text: 'A hook', images: [] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'Build the hook' } }] } },
    ]
    writeFileSync(join(projects, '2026-11-06-cut-off', '.m3d', 'transcript.jsonl'), cut.map((line) => JSON.stringify(line)).join('\n'))
    const app = spawnSidecar(join(dir, 'state'), projects)
    const state = (await app.call('state.get')) as { projects: { id: string }[] }
    expect(state.projects.map((p) => p.id).sort()).toEqual(['2026-11-06-cut-off', '2026-11-06-no-chat'])
    expect(((await app.call('chat.open', { project: '2026-11-06-no-chat' })) as ChatView).entries).toEqual([])
    const steps = ((await app.call('chat.open', { project: '2026-11-06-cut-off' })) as ChatView).entries.map(({ id: _, ...entry }) => entry)
    expect(steps[1]).toEqual({ kind: 'imported', role: 'tool', name: 'Bash', text: 'Build the hook', result: 'It stopped before it finished.', failed: true })
    await app.quit()
  })

  // Root can list a folder whatever its mode, so there the folder cannot be made unreadable.
  test.skipIf(process.getuid?.() === 0)('a projects folder that cannot be listed holds the start up for no one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-import-'))
    const projects = join(dir, 'projects')
    cpSync(CLIP, join(projects, '2026-11-06-a-wall-clip'), { recursive: true })
    chmodSync(projects, 0o000)
    try {
      const app = spawnSidecar(join(dir, 'state'), projects)
      const state = (await app.call('state.get')) as { projects: unknown[]; importBlocked: string | null }
      expect(state.projects).toEqual([])
      expect(state.importBlocked).toContain(projects)
      // The person allows the folder, and the import runs again at once.
      chmodSync(projects, 0o755)
      expect(await app.call('legacy.import', {})).toEqual({ imported: 1, blocked: null })
      const after = (await app.call('state.get')) as { projects: { id: string }[]; importBlocked: string | null }
      expect(after.projects.map((p) => p.id)).toEqual(['2026-11-06-a-wall-clip'])
      expect(after.importBlocked).toBeNull()
      await app.quit()
      expect(await app.stderr()).toContain('could not list')
    } finally {
      chmodSync(projects, 0o755)
    }
  })

  test('reads no old transcript on a launch after the import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-import-'))
    const projects = join(dir, 'projects')
    cpSync(CLIP, join(projects, '2026-11-06-a-wall-clip'), { recursive: true })
    const first = spawnSidecar(join(dir, 'state'), projects)
    await first.next()
    await first.quit()
    const transcript = join(projects, '2026-11-06-a-wall-clip', '.m3d', 'transcript.jsonl')
    rmSync(transcript)
    mkdirSync(transcript)
    const second = spawnSidecar(join(dir, 'state'), projects)
    expect(((await second.call('chat.open', { project: '2026-11-06-a-wall-clip' })) as ChatView).entries).toHaveLength(5)
    await second.quit()
    expect(await second.stderr()).not.toContain('2026-11-06-a-wall-clip')
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
    expect(((await app.call('state.get')) as { drafts: Record<string, unknown> }).drafts[project]).toMatchObject({ text: 'make it red', attachments: [] })
    await app.quit()
  })

  test('after a crash, the sidecar holds the pass before the cut-off work resumes, and leaves the work alone while an update installs', async () => {
    const where = scratch()
    const first = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
    await first.next()
    await first.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { id: project } = (await first.call('projects.create', { title: 'A cube' })) as { id: string }
    await first.call('chat.send', { project, requestId: 'r1', text: 'please wait', attachments: [] })
    const started = join(where.projects, project, 'started')
    while (!existsSync(started)) await Bun.sleep(25)
    first.child.kill('SIGKILL')
    await first.child.exited
    rmSync(started)

    const installing = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
    installing.gate.installing = true
    await installing.until((event) => event.type === 'ready')
    await Bun.sleep(1_500)
    // It asks for the pass again each second while the update installs, and never starts the work without it.
    expect(installing.gate.requests.length).toBeGreaterThan(0)
    expect(installing.gate.requests.every((busy) => busy)).toBe(true)
    expect(existsSync(started)).toBe(false)
    await installing.quit()

    const after = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
    await after.until((event) => event.type === 'ready')
    expect(after.gate.requests).toEqual([true])
    while (!existsSync(started)) await Bun.sleep(25)
    await after.quit()
  }, 30_000)

  test('after an install that failed, the work a crash cut off goes on once the gate opens again', async () => {
    const where = scratch()
    const first = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
    await first.next()
    await first.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { id: project } = (await first.call('projects.create', { title: 'A cube' })) as { id: string }
    await first.call('chat.send', { project, requestId: 'r1', text: 'please wait', attachments: [] })
    const started = join(where.projects, project, 'started')
    while (!existsSync(started)) await Bun.sleep(25)
    first.child.kill('SIGKILL')
    await first.child.exited
    rmSync(started)

    const app = spawnSidecar(where.data, where.projects, new Map(), { script: 'models', env: where.env })
    app.gate.installing = true
    await app.until((event) => event.type === 'ready')
    await Bun.sleep(1_500)
    expect(existsSync(started)).toBe(false)
    app.gate.installing = false
    while (!existsSync(started)) await Bun.sleep(25)
    await app.quit()
  }, 30_000)

  test('a tool that waited on a sign-in goes on only with the pass, so an install that started meanwhile holds it', async () => {
    const where = scratch()
    const app = spawnSidecar(where.data, where.projects, new Map(), { script: 'astra', env: where.env })
    await app.next()
    await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.send', { project, requestId: 'r1', text: 'go', attachments: [] })
    await app.until((event) => event.type === 'chat' && event.waiting !== null)
    app.gate.installing = true
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'astra-key' })
    await Bun.sleep(2_000)
    expect(existsSync(join(where.projects, project, 'astra.txt'))).toBe(false)
    app.gate.installing = false
    await app.until((event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant' && entry.text === 'parent saw: astra drew it'), 30_000)
    await app.quit()
  }, 40_000)

  /** A turn whose Astra tool signed in while an update installs, so it waits for the pass. */
  async function waitingForPass() {
    const where = scratch()
    const keychain = new Map<string, string>()
    const app = spawnSidecar(where.data, where.projects, keychain, { script: 'astra', env: where.env })
    await app.next()
    await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.send', { project, requestId: 'r1', text: 'go', attachments: [] })
    await app.until((event) => event.type === 'chat' && event.waiting !== null)
    app.gate.installing = true
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'astra-key' })
    await Bun.sleep(1_500)
    return { where, keychain, app, project }
  }

  test('a stop ends a tool that waits for the pass after its sign-in', async () => {
    const { where, app, project } = await waitingForPass()
    await app.call('chat.stop', { project })
    await app.until((event) => event.type === 'chat' && event.project === project && event.running === false, 5_000)
    expect(existsSync(join(where.projects, project, 'astra.txt'))).toBe(false)
    await app.quit()
  }, 40_000)

  test('a quit leaves a tool that waits for the pass unfinished, so it goes on after the restart', async () => {
    const { where, keychain, app, project } = await waitingForPass()
    const quit = await Promise.race([app.quit().then(() => 'exited'), Bun.sleep(5_000).then(() => 'still running')])
    expect(quit).toBe('exited')
    expect(existsSync(join(where.projects, project, 'astra.txt'))).toBe(false)

    const after = spawnSidecar(where.data, where.projects, keychain, { script: 'astra', env: where.env })
    await after.next()
    const done = (entries: ChatEntry[]) => entries.some((entry) => entry.kind === 'assistant' && entry.text === 'parent saw: astra drew it')
    if (!done(((await after.call('chat.open', { project })) as ChatView).entries)) {
      await after.until((event) => event.type === 'chat' && done(event.entries as ChatEntry[]), 30_000)
    }
    await after.quit()
  }, 60_000)

  test('gives the pass back while Astra waits on a sign-in, even when a tool beside it already finished', async () => {
    const where = scratch()
    const app = spawnSidecar(where.data, where.projects, new Map(), { script: 'astra-and-read', env: where.env })
    await app.next()
    await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    writeFileSync(join(where.projects, project, 'note.txt'), 'a note')
    await app.call('chat.send', { project, requestId: 'r1', text: 'go', attachments: [] })
    await app.until((event) => event.type === 'chat' && event.waiting !== null)
    const deadline = Date.now() + 5_000
    while (app.gate.requests.at(-1) !== false && Date.now() < deadline) await Bun.sleep(25)
    expect(app.gate.requests.at(-1)).toBe(false)
    await app.quit()
  }, 30_000)

  test('gives the pass back while a turn waits on a sign-in, and takes it again when the turn goes on', async () => {
    const where = scratch()
    const app = spawnSidecar(where.data, where.projects, new Map(), { script: 'astra', env: where.env })
    await app.next()
    await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { id: project } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
    await app.call('chat.send', { project, requestId: 'r1', text: 'go', attachments: [] })
    await app.until((event) => event.type === 'chat' && event.waiting !== null)
    const deadline = Date.now() + 5_000
    while (app.gate.requests.at(-1) !== false && Date.now() < deadline) await Bun.sleep(25)
    expect(app.gate.requests).toEqual([true, false])

    await app.call('auth.setKey', { provider: 'openai-codex', key: 'astra-key' })
    await app.until((event) => event.type === 'chat' && (event.entries as ChatEntry[]).some((entry) => entry.kind === 'assistant' && entry.text === 'parent saw: astra drew it'))
    while (app.gate.requests.at(-1) !== false) await Bun.sleep(25)
    expect(app.gate.requests.slice(2)).toContain(true)
    await app.quit()
  }, 30_000)
})
