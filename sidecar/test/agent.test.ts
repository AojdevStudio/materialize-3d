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

/** Sends a first message from the start screen, which makes its project, and answers that project. */
async function firstSend(app: App, text: string): Promise<string> {
  await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
  return (await app.sendDraft('new', text)).project
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

const saveDraft = async (app: App, key: string, text: string) =>
  ((await app.call('drafts.set', { key, text, attachments: [] })) as { rev: number }).rev

describe('a send', () => {
  test('commits the message, the settings its turn runs with, and the draft removal together, and only once', async () => {
    const where = scratch()
    const app = start(where, 'models')
    await app.next()
    await app.call('settings.set', { model: { provider: 'faux', modelId: 'faux-a' } })
    const { project, rev } = await app.sendDraft('new', 'A 20 mm cube')
    expect(((await app.call('state.get')) as { drafts: object }).drafts).toEqual({})
    const view = (await app.call('chat.open', { project })) as ChatView
    expect(view.entries[0]).toMatchObject({ kind: 'user', text: 'A 20 mm cube' })
    expect(view.turn).toMatchObject({
      requestId: `draft-${rev}`,
      model: { provider: 'faux', modelId: 'faux-a' },
      thinking: 'high',
      tools: ['read', 'write', 'edit', 'run', 'slice', 'astra'],
      app: '9.9.9',
    })
    await answered(app, project, 'answered by faux-a')

    await app.call('chat.send', { key: project, rev })
    const again = (await app.call('chat.open', { project })) as ChatView
    expect(again.entries.filter((entry) => entry.kind === 'user')).toHaveLength(1)

    // A send while a turn runs is refused whole: no message, and the draft stays.
    await app.sendDraft(project, 'please wait')
    await waitForFile(join(where.projects, project, 'started'))
    const red = await saveDraft(app, project, 'make it red')
    await expect(app.call('chat.send', { key: project, rev: red })).rejects.toThrow('The agent is still working on the last message.')
    expect(((await app.call('state.get')) as { drafts: Record<string, unknown> }).drafts[project]).toEqual({ text: 'make it red', attachments: [], rev: red })
    const refused = (await app.call('chat.open', { project })) as ChatView
    expect(refused.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.kind === 'user' && entry.text)).toEqual(['A 20 mm cube', 'please wait'])
    writeFileSync(join(where.projects, project, 'go'), '')
    await answered(app, project, 'answered by faux-a')
    await app.quit()
  })
})

describe('a restart', () => {
  test("sends each chat's state once it has reconciled, even a chat that is idle", async () => {
    const where = scratch()
    const first = start(where, 'models')
    await first.next()
    const project = await firstSend(first, 'hello')
    await first.until((event) => event.type === 'chat' && event.project === project && event.running === false && (event.entries as ChatEntry[]).some((e) => e.kind === 'assistant'), 20_000)
    first.child.kill('SIGKILL')
    await first.child.exited
    const reopened = start(where, 'models')
    await reopened.next()
    const state = await reopened.until((event) => event.type === 'chat' && event.project === project, 5_000)
    expect(state.running).toBe(false)
    await reopened.quit()
  }, 30_000)
})

describe('a crash mid-turn', () => {
  test('the reopened sidecar finishes the turn and never repeats a finished tool call', async () => {
    const where = scratch()
    const first = start(where, 'ops')
    await first.next()
    const project = await firstSend(first, 'Build it')
    const log = join(where.projects, project, 'ops.log')
    await waitForFile(log)
    while (!readFileSync(log, 'utf8').includes('op2')) await Bun.sleep(25)
    const before = ((await first.call('chat.open', { project })) as ChatView).seq
    first.child.kill('SIGKILL')
    await first.child.exited
    // The watch on op2 ends it within a second of the crash, before `go` would let it finish.
    await Bun.sleep(1500)

    const reopened = start(where, 'ops')
    await reopened.next()
    // The window still holds the views the crashed sidecar sent, so the new one's must come after them, and the
    // reopened sidecar sends each chat's state once it has reconciled, as the window may have read it before that.
    const reconciled = await reopened.until((event) => event.type === 'chat' && event.project === project)
    expect(reconciled.seq).toBeGreaterThan(before)
    expect(((await reopened.call('chat.open', { project })) as ChatView).seq).toBeGreaterThan(before)
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

describe('a quit mid-turn', () => {
  test('the reopened sidecar runs the command the quit cut off again, and never repeats a finished tool call', async () => {
    const where = scratch()
    const first = start(where, 'ops')
    await first.next()
    const project = await firstSend(first, 'Build it')
    const log = join(where.projects, project, 'ops.log')
    await waitForFile(log)
    while (!readFileSync(log, 'utf8').includes('op2')) await Bun.sleep(25)
    // Cmd-Q: Rust closes the sidecar's stdin, and the sidecar stops its turns and closes its store.
    await first.quit()

    const reopened = start(where, 'ops')
    await reopened.next()
    writeFileSync(join(where.projects, project, 'go'), '')
    await answered(reopened, project, 'done')

    // op1 finished before the quit and ran once. op2 was cut off mid-run, so it ran again from its start.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['op1', 'op2', 'op2'])
    const view = (await reopened.call('chat.open', { project })) as ChatView
    const results = view.entries.flatMap((entry) => (entry.kind === 'tool' ? [entry.text.split('\n')[0]] : []))
    expect(results).toEqual(['exit code 0', 'exit code 0'])
    expect(view.running).toBe(false)
    await reopened.quit()
  }, 20_000)
})

describe("a project's model", () => {
  test('a change mid-turn leaves the running turn alone, and the next turn uses it', async () => {
    const where = scratch()
    const app = start(where, 'models')
    await app.next()
    const project = await firstSend(app, 'please wait')
    await waitForFile(join(where.projects, project, 'started'))
    await app.call('projects.setModel', { project, model: { provider: 'faux', modelId: 'faux-b' } })
    writeFileSync(join(where.projects, project, 'go'), '')
    await answered(app, project, 'answered by faux-a')
    expect(((await app.call('chat.open', { project })) as ChatView).turn?.model.modelId).toBe('faux-a')

    await app.sendDraft(project, 'and now?')
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
    const project = await firstSend(app, 'read the hostname')
    expect(await app.call('agent.tools', { project })).toEqual(['read', 'write', 'edit', 'run', 'slice', 'astra'])
    await answered(app, project, 'tried')
    const view = (await app.call('chat.open', { project })) as ChatView
    const read = view.entries.find((entry) => entry.kind === 'tool')
    expect(read).toMatchObject({ kind: 'tool', name: 'read', failed: true })
    expect(read?.kind === 'tool' && read.text).toContain('outside the project folder')
    await app.quit()
  })

  test('says how long each step it ran took', async () => {
    const where = scratch()
    const app = start(where, 'escape')
    await app.next()
    const project = await firstSend(app, 'read the hostname')
    await answered(app, project, 'tried')
    const view = (await app.call('chat.open', { project })) as ChatView
    expect(view.entries.find((entry) => entry.kind === 'tool')).toMatchObject({ kind: 'tool', durationMs: expect.any(Number) })
    await app.quit()
  })
})
