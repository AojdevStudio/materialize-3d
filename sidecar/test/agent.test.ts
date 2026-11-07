import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatEntry, ChatView } from '../src/protocol'
import { spawnSidecar } from './sidecar'

type App = ReturnType<typeof spawnSidecar>

/** A scratch store, project root, and a `uv` that runs what follows `uv run`, so tests need neither uv nor Python. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-agent-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
  chmodSync(join(bin, 'uv'), 0o755)
  return { data: join(dir, 'state'), projects: join(dir, 'projects'), env: { PATH: `${bin}:${process.env.PATH}` } }
}

function start(where: ReturnType<typeof scratch>, script: string): App {
  return spawnSidecar(where.data, where.projects, new Map(), { script, env: where.env })
}

async function newProject(app: App, modelId = 'faux-a'): Promise<string> {
  await app.call('settings.set', { model: { provider: 'faux', modelId } })
  const { id } = (await app.call('projects.create', { title: 'A 20 mm cube' })) as { id: string }
  await app.call('chat.open', { project: id })
  return id
}

const hasAnswer = (entries: ChatEntry[], text: string) => entries.some((entry) => entry.kind === 'assistant' && entry.text === text)

/** Waits until the chat holds this answer: already in the committed chat, or in a later change. */
async function answered(app: App, project: string, text: string): Promise<void> {
  const view = (await app.call('chat.open', { project })) as ChatView
  if (hasAnswer(view.entries, text)) return
  await app.until((event) => event.type === 'chat' && event.project === project && hasAnswer(event.entries as ChatEntry[], text))
}

async function waitForFile(path: string, ms = 15_000) {
  const deadline = Date.now() + ms
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} never appeared`)
    await Bun.sleep(25)
  }
}

const send = (app: App, project: string, requestId: string, text: string) => app.call('chat.send', { project, requestId, text, attachments: [] })

describe('a send', () => {
  test('commits the message, the settings its turn runs with, and the draft removal together, and only once', async () => {
    const where = scratch()
    const app = start(where, 'models')
    await app.next()
    const project = await newProject(app)
    await app.call('drafts.set', { key: project, text: 'A 20 mm cube', attachments: [] })

    await send(app, project, 'r1', 'A 20 mm cube')
    expect(((await app.call('state.get')) as { drafts: object }).drafts).toEqual({})
    const view = (await app.call('chat.open', { project })) as ChatView
    expect(view.entries[0]).toMatchObject({ kind: 'user', text: 'A 20 mm cube' })
    expect(view.turn).toMatchObject({
      requestId: 'r1',
      model: { provider: 'faux', modelId: 'faux-a' },
      thinking: 'high',
      tools: ['read', 'write', 'edit', 'run', 'slice', 'astra'],
      app: '9.9.9',
    })
    await answered(app, project, 'answered by faux-a')

    await send(app, project, 'r1', 'A 20 mm cube')
    const again = (await app.call('chat.open', { project })) as ChatView
    expect(again.entries.filter((entry) => entry.kind === 'user')).toHaveLength(1)

    // A send while a turn runs is refused whole: no message, and the draft stays.
    await send(app, project, 'r2', 'please wait')
    await waitForFile(join(where.projects, project, 'started'))
    await app.call('drafts.set', { key: project, text: 'make it red', attachments: [] })
    await expect(send(app, project, 'r3', 'make it red')).rejects.toThrow('The agent is still working on the last message.')
    expect(((await app.call('state.get')) as { drafts: Record<string, unknown> }).drafts[project]).toEqual({ text: 'make it red', attachments: [] })
    const refused = (await app.call('chat.open', { project })) as ChatView
    expect(refused.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.kind === 'user' && entry.text)).toEqual(['A 20 mm cube', 'please wait'])
    writeFileSync(join(where.projects, project, 'go'), '')
    await answered(app, project, 'answered by faux-a')
    await app.quit()
  })
})

describe('a crash mid-turn', () => {
  test('the reopened sidecar finishes the turn and never repeats a finished tool call', async () => {
    const where = scratch()
    const first = start(where, 'ops')
    await first.next()
    const project = await newProject(first)
    await send(first, project, 'r1', 'Build it')
    const log = join(where.projects, project, 'ops.log')
    await waitForFile(log)
    while (!readFileSync(log, 'utf8').includes('op2')) await Bun.sleep(25)
    first.child.kill('SIGKILL')
    await first.child.exited
    // The watch on op2 ends it within a second of the crash, before `go` would let it finish.
    await Bun.sleep(1500)

    const reopened = start(where, 'ops')
    await reopened.next()
    await reopened.call('chat.open', { project })
    writeFileSync(join(where.projects, project, 'go'), '')
    await answered(reopened, project, 'done')

    // op1 finished before the crash and ran once. op2 was cut off mid-run, so it ran again from its start.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['op1', 'op2', 'op2'])
    const view = (await reopened.call('chat.open', { project })) as ChatView
    expect(view.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    expect(view.running).toBe(false)
    await reopened.quit()
  }, 20_000)
})

describe('settings', () => {
  test('a change mid-turn leaves the running turn alone, and the next turn uses it', async () => {
    const where = scratch()
    const app = start(where, 'models')
    await app.next()
    const project = await newProject(app, 'faux-a')
    await send(app, project, 'r1', 'please wait')
    await waitForFile(join(where.projects, project, 'started'))
    await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-b' } })
    writeFileSync(join(where.projects, project, 'go'), '')
    await answered(app, project, 'answered by faux-a')
    expect(((await app.call('chat.open', { project })) as ChatView).turn?.model.modelId).toBe('faux-a')

    await send(app, project, 'r2', 'and now?')
    await answered(app, project, 'answered by faux-b')
    expect(((await app.call('chat.open', { project })) as ChatView).turn?.model.modelId).toBe('faux-b')
    await app.quit()
  })
})

describe('the agent', () => {
  test('is offered only the app tools, and they never reach outside the project folder', async () => {
    const where = scratch()
    const app = start(where, 'escape')
    await app.next()
    const project = await newProject(app)
    expect(await app.call('agent.tools', { project })).toEqual(['read', 'write', 'edit', 'run', 'slice', 'astra'])
    await send(app, project, 'r1', 'read the hostname')
    await answered(app, project, 'tried')
    const view = (await app.call('chat.open', { project })) as ChatView
    const read = view.entries.find((entry) => entry.kind === 'tool')
    expect(read).toMatchObject({ kind: 'tool', name: 'read', failed: true })
    expect(read?.kind === 'tool' && read.text).toContain('outside the project folder')
    await app.quit()
  })
})
