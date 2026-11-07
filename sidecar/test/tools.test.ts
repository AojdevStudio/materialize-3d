import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once, operationId } from '../src/agent'
import type { ChatEntry, ChatView } from '../src/protocol'
import { spawnSidecar } from './sidecar'

type App = ReturnType<typeof spawnSidecar>

function scratch(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-tools-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
  chmodSync(join(bin, 'uv'), 0o755)
  return { dir, data: join(dir, 'state'), projects: join(dir, 'projects'), env: { PATH: `${bin}:${process.env.PATH}`, ...env } }
}

const start = (where: ReturnType<typeof scratch>, script: string, version?: string) =>
  spawnSidecar(where.data, where.projects, new Map(), { script, env: where.env, ...(version === undefined ? {} : { version }) })

async function newProject(app: App) {
  await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
  const { id } = (await app.call('projects.create', { title: 'A cube' })) as { id: string }
  await app.call('chat.open', { project: id })
  return id
}

const send = (app: App, project: string, requestId: string, text = 'go') => app.call('chat.send', { project, requestId, text, attachments: [] })

/** Waits until the chat holds this answer, already committed or in a later change. */
async function answered(app: App, project: string, text: string) {
  const has = (entries: ChatEntry[]) => entries.some((entry) => entry.kind === 'assistant' && entry.text === text)
  if (has(((await app.call('chat.open', { project })) as ChatView).entries)) return
  await app.until((event) => event.type === 'chat' && event.project === project && has(event.entries as ChatEntry[]), 30_000)
}

const toolResults = async (app: App, project: string) =>
  ((await app.call('chat.open', { project })) as ChatView).entries.flatMap((entry) => (entry.kind === 'tool' ? [entry] : []))

describe('an outside action', () => {
  test('runs once per operation: a rerun takes the result Pi kept, or else the receipt file the action left', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-once-'))
    let kept: { n: number } | undefined
    const memo = { get: async () => kept, set: async (value: { n: number }) => (kept = value) }
    let acted = 0
    const act = async () => ({ n: ++acted })

    expect(await once(memo, join(dir, 'op1.json'), act)).toEqual({ n: 1 })
    expect(JSON.parse(readFileSync(join(dir, 'op1.json'), 'utf8'))).toEqual({ n: 1 })
    expect(await once(memo, join(dir, 'op1.json'), act)).toEqual({ n: 1 })

    // A crash after the action and its receipt file, before Pi kept the result.
    kept = undefined
    expect(await once(memo, join(dir, 'op1.json'), act)).toEqual({ n: 1 })
    expect(await memo.get()).toEqual({ n: 1 })
    expect(acted).toBe(1)
  })

  test('calls whose ids differ only in characters a file name cannot hold keep separate receipts', () => {
    expect(operationId('call/a')).not.toBe(operationId('call:a'))
    expect(operationId('call/a')).toBe(operationId('call/a'))
  })
})

describe('the run tool', () => {
  test('gets none of the sidecar environment but what commands need, plus its operation id', async () => {
    const where = scratch({ M3D_SECRET: 'leak' })
    const app = start(where, 'env')
    await app.next()
    const project = await newProject(app)
    await send(app, project, 'r1')
    await answered(app, project, 'exit code 0\nsecret=none op=set\n')
    expect(readdirSync(join(where.projects, project, '.m3d', 'ops'))).toHaveLength(1)
    await app.quit()
  })

  test('stops a command at its timeout, in seconds', async () => {
    const where = scratch()
    const app = start(where, 'slow')
    await app.next()
    const project = await newProject(app)
    await send(app, project, 'r1')
    await answered(app, project, 'timed')
    expect((await toolResults(app, project))[0]).toMatchObject({ name: 'run', failed: true })
    await Bun.sleep(2500)
    expect(existsSync(join(where.projects, project, 'finished'))).toBe(false)
    await app.quit()
  }, 20_000)

  test('ends with its sidecar, so a command a crash cut off never runs on beside the rerun', async () => {
    const where = scratch()
    const app = start(where, 'orphan')
    await app.next()
    const project = await newProject(app)
    await send(app, project, 'r1')
    while (!existsSync(join(where.projects, project, 'started'))) await Bun.sleep(25)
    app.child.kill('SIGKILL')
    await app.child.exited
    await Bun.sleep(5000)
    expect(existsSync(join(where.projects, project, 'finished'))).toBe(false)
  }, 20_000)
})

describe('the file tools', () => {
  test('never follow a symbolic link out of the project', async () => {
    const where = scratch()
    const outside = join(where.dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const app = start(where, 'linked')
    await app.next()
    const project = await newProject(app)
    symlinkSync(outside, join(where.projects, project, 'linked'))
    // A link to a file that does not exist yet: writing through it would make the file outside.
    symlinkSync(join(outside, 'made-outside.txt'), join(where.projects, project, 'dangling'))
    // A link to a file not made yet, through `linked` and then up: the system climbs from where `linked` leads.
    symlinkSync('linked/../climbed.txt', join(where.projects, project, 'climb'))
    await send(app, project, 'r1')
    await answered(app, project, 'tried')
    const results = await toolResults(app, project)
    expect(results.map((r) => [r.name, r.failed])).toEqual([['read', true], ['write', true], ['edit', true], ['write', true], ['write', true]])
    for (const result of results) expect(result.text).toContain('outside the project folder')
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret')
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    expect(existsSync(join(outside, 'made-outside.txt'))).toBe(false)
    expect(existsSync(join(where.dir, 'climbed.txt'))).toBe(false)
    await app.quit()
  })
})

describe('Astra', () => {
  test('without its sign-in, the turn waits with the fix named, and goes on once the person signs in', async () => {
    const where = scratch()
    const app = start(where, 'astra')
    await app.next()
    const project = await newProject(app)
    await send(app, project, 'r1')
    const waiting = await app.until((event) => event.type === 'chat' && event.waiting !== null)
    expect(waiting.waiting).toEqual({
      kind: 'login',
      provider: 'openai-codex',
      name: 'openai-codex',
      fix: 'Sign in to openai-codex. Astra picks up where it stopped.',
    })
    expect(waiting.running).toBe(true)
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'astra-key' })
    await answered(app, project, 'parent saw: astra drew it')
    expect(((await app.call('chat.open', { project })) as ChatView).waiting).toBeNull()
    expect(readFileSync(join(where.projects, project, 'astra.txt'), 'utf8')).toBe('astra-ran\n')
    await app.quit()
  })

  test('a sign-in the provider refuses makes the turn wait for a new one, instead of asking again and again', async () => {
    const where = scratch()
    const app = start(where, 'astra')
    await app.next()
    const project = await newProject(app)
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'refused' })
    await send(app, project, 'r1')
    const waiting = await app.until((event) => event.type === 'chat' && event.waiting !== null, 30_000)
    expect(waiting.waiting).toMatchObject({ kind: 'login', provider: 'openai-codex' })
    expect(waiting.running).toBe(true)
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'astra-key' })
    await answered(app, project, 'parent saw: astra drew it')
    expect(((await app.call('chat.open', { project })) as ChatView).waiting).toBeNull()
    await app.quit()
  }, 60_000)

  test('a wait a crash cut off is let go once the sign-in is there, and the turn finishes', async () => {
    const where = scratch()
    const keychain = new Map<string, string>()
    const first = spawnSidecar(where.data, where.projects, keychain, { script: 'astra', env: where.env })
    await first.next()
    const project = await newProject(first)
    await send(first, project, 'r1')
    await first.until((event) => event.type === 'chat' && event.waiting !== null)
    first.child.kill('SIGKILL')
    await first.child.exited

    // The sign-in lands in the Keychain while the app is closed.
    keychain.set('openai-codex', JSON.stringify({ type: 'api_key', key: 'astra-key' }))
    const second = spawnSidecar(where.data, where.projects, keychain, { script: 'astra', env: where.env })
    await second.next()
    await answered(second, project, 'parent saw: astra drew it')
    expect(((await second.call('chat.open', { project })) as ChatView).waiting).toBeNull()
    await second.quit()
  })
})

describe('a restart', () => {
  test('watches every chat, so a resumed run that then fails waits with its fix even if no one opened it', async () => {
    const where = scratch()
    const first = start(where, 'fails-after')
    await first.next()
    const project = await newProject(first)
    await send(first, project, 'r1')
    while (!existsSync(join(where.projects, project, 'started'))) await Bun.sleep(25)
    first.child.kill('SIGKILL')
    await first.child.exited

    const second = start(where, 'fails-after')
    await second.next()
    writeFileSync(join(where.projects, project, 'go'), '')
    const waiting = await second.until((event) => event.type === 'chat' && event.waiting !== null, 60_000)
    expect(waiting).toMatchObject({ project, running: false, waiting: { kind: 'error', fix: 'Try again' } })
    await second.quit()
  })

  test('after an update, a turn that waited on a sign-in from the old version waits for the person to go on', async () => {
    const where = scratch()
    const first = start(where, 'models', '1.0.0')
    await first.next()
    await first.call('settings.set', { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' } })
    const { id: project } = (await first.call('projects.create', { title: 'A cube' })) as { id: string }
    await first.call('chat.open', { project })
    await send(first, project, 'r1')
    await first.until((event) => event.type === 'chat' && event.waiting !== null)
    await first.quit()

    const second = start(where, 'models', '2.0.0')
    await second.next()
    const view = (await second.call('chat.open', { project })) as ChatView
    expect(view.waiting).toEqual({ kind: 'error', detail: 'Materialize 3D was updated to 2.0.0 while this turn ran.', fix: 'Go on' })
    await second.quit()
  })

  test('after an update stops a turn that ran on the old version, until the person goes on with the new one', async () => {
    const where = scratch()
    const first = start(where, 'models', '1.0.0')
    await first.next()
    const project = await newProject(first)
    await send(first, project, 'r1', 'please wait')
    while (!existsSync(join(where.projects, project, 'started'))) await Bun.sleep(25)
    first.child.kill('SIGKILL')
    await first.child.exited

    const second = start(where, 'models', '2.0.0')
    await second.next()
    const view = (await second.call('chat.open', { project })) as ChatView
    expect(view).toMatchObject({ running: false, waiting: { kind: 'error', detail: 'Materialize 3D was updated to 2.0.0 while this turn ran.', fix: 'Go on' } })
    expect(view.turn?.app).toBe('1.0.0')

    writeFileSync(join(where.projects, project, 'go'), '')
    await second.call('chat.retry', { project })
    await answered(second, project, 'answered by faux-a')
    const after = (await second.call('chat.open', { project })) as ChatView
    expect(after.turn).toMatchObject({ app: '2.0.0', model: { modelId: 'faux-a' } })
    expect(after.waiting).toBeNull()
    await second.quit()
  })
})
