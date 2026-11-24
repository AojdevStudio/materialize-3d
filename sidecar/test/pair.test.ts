import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { AgentDoc, type ConversationId, createRegistry, defineDoc, type TaskId } from '@earendil-works/pi-durable'
import type { AppState, ChatEntry, ChatView, ModelChoice, Need, Project, Turn } from '../src/protocol'
import { Store } from '../src/store'
import { spawnSidecar } from './sidecar'

type App = ReturnType<typeof spawnSidecar>
type Where = ReturnType<typeof scratch>

const FAUX_A = { provider: 'faux', modelId: 'faux-a' }
const FAUX_B = { provider: 'faux', modelId: 'faux-b' }
const ASTRA = { provider: 'openai-codex', modelId: 'gpt-6-astra' }
const SOL_6_1 = { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }
const SOL_6_3 = { provider: 'openai-codex', modelId: 'gpt-6.3-sol' }
const OPUS = { provider: 'anthropic', modelId: 'claude-opus-5-5' }
const CODEX_KEY = JSON.stringify({ type: 'api_key', key: 'codex-key' })

/** A scratch store, project root, and a `uv` that runs what follows `uv run`, so tests need neither uv nor Python. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-pair-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uv'), '#!/bin/sh\n[ "$1" = run ] && shift\nexec "$@"\n')
  chmodSync(join(bin, 'uv'), 0o755)
  return { data: join(dir, 'state'), projects: join(dir, 'projects'), env: { PATH: `${bin}:${process.env.PATH}` }, keychain: new Map<string, string>() }
}

async function start(where: Where, script: string, env: Record<string, string> = {}): Promise<App> {
  const app = spawnSidecar(where.data, where.projects, where.keychain, { script, env: { ...where.env, ...env } })
  await app.next()
  return app
}

const view = async (app: App, project: string) => (await app.call('chat.open', { project })) as ChatView
const answers = (entries: ChatEntry[]) => entries.flatMap((entry) => (entry.kind === 'assistant' && entry.text !== '' ? [entry] : []))
const projectIn = async (app: App, id: string) => ((await app.call('state.get')) as AppState).projects.find((p) => p.id === id)

/** Waits until the chat holds this answer, already committed or in a later change. */
async function answered(app: App, project: string, text: string): Promise<void> {
  const has = (entries: ChatEntry[]) => answers(entries).some((entry) => entry.text === text)
  if (has((await view(app, project)).entries)) return
  await app.until((event) => event.type === 'chat' && event.project === project && has(event.entries as ChatEntry[]), 30_000)
}

/** A project made on the start screen with `lead`, then given `helper`, ready for its first real message. */
async function project(app: App, lead: ModelChoice, helper: ModelChoice | null): Promise<string> {
  await app.call('settings.set', { model: lead })
  const { project } = await app.sendDraft('new', 'make the project')
  await answered(app, project, 'made')
  await app.call('projects.setHelper', { project, model: helper })
  return project
}

/** Opens the store the sidecar left, once it has quit, to read what only the store holds. */
const openStore = (where: Where) =>
  Store.open({
    dataDir: where.data,
    projectsDir: where.projects,
    models: createModels({ credentials: new InMemoryCredentialStore() }),
    registry: createRegistry(),
    env: () => {
      throw new Error('no conversation runs here')
    },
  })

describe('a new chat', () => {
  test('starts with Opus and Astra when ChatGPT is signed in, and with Opus alone when it is not', async () => {
    const where = scratch()
    const app = await start(where, 'models')
    const { project: alone } = await app.sendDraft('new', 'a clip')
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'codex-key' })
    const { project: paired } = await app.sendDraft('new', 'a knob')
    expect(await projectIn(app, alone)).toMatchObject({ model: OPUS, helper: null })
    expect(await projectIn(app, paired)).toMatchObject({ model: OPUS, helper: ASTRA })
    await app.quit()
  })
})

describe('a pair', () => {
  test('with no helper, the lead works alone and is not offered the helper tool', async () => {
    const where = scratch()
    const app = await start(where, 'models')
    const id = await project(app, FAUX_A, null)
    await app.sendDraft(id, 'which model?')
    await answered(app, id, 'answered by faux-a')
    expect(await app.call('agent.tools', { project: id })).toEqual(['read', 'write', 'edit', 'run', 'slice'])
    expect((await view(app, id)).turn).toMatchObject({ model: FAUX_A, helper: null, tools: ['read', 'write', 'edit', 'run', 'slice'] })
    await app.quit()
  })

  test('can hold the same model in both roles: the helper runs, and its answer reaches the lead', async () => {
    const where = scratch()
    const app = await start(where, 'helper')
    const id = await project(app, FAUX_A, FAUX_A)
    await app.sendDraft(id, 'go')
    await answered(app, id, 'parent saw: faux-a drew it')
    expect(readFileSync(join(where.projects, id, 'helper.txt'), 'utf8')).toBe('faux-a\n')
    expect((await view(app, id)).turn).toMatchObject({ model: FAUX_A, helper: FAUX_A })
    await app.quit()
  })

  test("runs lead-alone while the Settings Astra switch is off, and keeps the chat's helper for when it is on again", async () => {
    const where = scratch()
    const app = await start(where, 'models')
    const id = await project(app, FAUX_A, FAUX_B)
    await app.call('settings.set', { astra: false })
    await app.sendDraft(id, 'which model?')
    await answered(app, id, 'answered by faux-a')
    expect((await view(app, id)).turn).toMatchObject({ model: FAUX_A, helper: null })
    expect(await app.call('agent.tools', { project: id })).not.toContain('helper')
    expect(await projectIn(app, id)).toMatchObject({ helper: FAUX_B })

    await app.call('settings.set', { astra: true })
    await app.sendDraft(id, 'and now?')
    await app.until((event) => event.type === 'chat' && event.project === id && (event.turn as { helper?: unknown } | null)?.helper !== null)
    expect((await view(app, id)).turn).toMatchObject({ model: FAUX_A, helper: FAUX_B })
    await app.quit()
  })

  test('a start-screen send with the Astra switch off reads no ChatGPT login, so a slow Keychain never holds it', async () => {
    const where = scratch()
    // The ChatGPT login read never answers, as a Keychain that waits on the person.
    const app = spawnSidecar(where.data, where.projects, where.keychain, {
      script: 'models',
      env: where.env,
      hold: (request, answer) => {
        if (request.method === 'keychain.get' && (request.params as { account: string }).account === 'openai-codex') return
        answer()
      },
    })
    await app.next()
    await app.call('settings.set', { model: FAUX_A, astra: false })
    const sent = app.sendDraft('new', 'which model?')
    const result = await Promise.race([sent.then(() => 'sent'), Bun.sleep(10_000).then(() => 'held')])
    expect(result).toBe('sent')
    const { project: id } = await sent
    await answered(app, id, 'answered by faux-a')
    expect(await projectIn(app, id)).toMatchObject({ model: FAUX_A, helper: null })
    app.child.kill('SIGKILL')
  }, 30_000)

  test('is frozen for its turn: an edit and a crash before the helper runs leave the turn on its pair, and the next message takes the edit', async () => {
    const where = scratch()
    const first = await start(where, 'wait-then-helper')
    const id = await project(first, FAUX_A, FAUX_B)
    await first.sendDraft(id, 'go')
    while (!existsSync(join(where.projects, id, 'started'))) await Bun.sleep(25)
    await first.call('projects.setLead', { project: id, model: FAUX_B })
    await first.call('projects.setHelper', { project: id, model: FAUX_A })
    first.child.kill('SIGKILL')
    await first.child.exited

    writeFileSync(join(where.projects, id, 'go'), '')
    const second = await start(where, 'wait-then-helper')
    await answered(second, id, 'parent saw: faux-b drew it')
    expect((await view(second, id)).turn).toMatchObject({ model: FAUX_A, helper: FAUX_B })

    await second.sendDraft(id, 'go again')
    await answered(second, id, 'parent saw: faux-a drew it')
    const after = await view(second, id)
    expect(after.turn).toMatchObject({ model: FAUX_B, helper: FAUX_A })
    expect(answers(after.entries).at(-1)?.model).toEqual(FAUX_B)
    await second.quit()
  }, 60_000)
})

describe('the helper call', () => {
  test('gives the helper only the file tools and run, so it cannot hand the task on', async () => {
    const where = scratch()
    const app = await start(where, 'helper')
    const id = await project(app, FAUX_A, FAUX_B)
    await app.sendDraft(id, 'ask: Hand this on.')
    await app.until((event) => event.type === 'chat' && answers(event.entries as ChatEntry[]).some((entry) => entry.text.startsWith('parent saw: child saw:')), 30_000)
    const call = (await view(app, id)).entries.find((entry) => entry.kind === 'tool' && entry.name === 'helper')
    expect(call).toMatchObject({ failed: false, handoff: { helper: FAUX_B } })
    await app.quit()

    const store = await openStore(where)
    const child = call?.kind === 'tool' ? call.handoff?.conversation : undefined
    expect((await store.harness.snapshot(AgentDoc, child as ConversationId, BACKGROUND_CONTEXT))?.tools).toEqual(['read', 'write', 'edit', 'run'])
    await store.close()
  })

  test("that fails gives the lead the failure, and its handoff names the task that owns the helper's conversation", async () => {
    const where = scratch()
    const app = await start(where, 'helper')
    const id = await project(app, FAUX_A, FAUX_B)
    await app.sendDraft(id, 'ask: Fail.')
    await app.until((event) => event.type === 'chat' && answers(event.entries as ChatEntry[]).some((entry) => entry.text.startsWith('parent saw: Helper faux-b failed')), 30_000)
    const call = (await view(app, id)).entries.find((entry) => entry.kind === 'tool' && entry.name === 'helper')
    expect(call).toMatchObject({ failed: true, text: 'Helper faux-b failed (model_error: 400 invalid_request_error: the helper could not do this task).' })
    await app.quit()

    const handoff = call?.kind === 'tool' ? call.handoff : undefined
    const store = await openStore(where)
    const owned = await store.harness.commit((tx) => tx.scanConversations({ ownerTaskId: Number(handoff?.task) as TaskId }, 5), BACKGROUND_CONTEXT)
    expect(owned.items.map((conversation) => conversation.id)).toEqual([handoff?.conversation as ConversationId])
    await store.close()
  })
})

describe('chats from before pairs', () => {
  /** A store whose settings and one project are as an app before pairs left them. */
  async function before(where: Where, astra: boolean, model: ModelChoice | undefined) {
    const old = await openStore(where)
    const ProjectsBeforePairs = defineDoc<{ projects: (Omit<Project, 'model' | 'helper'> & { model?: ModelChoice })[] }>({
      kind: 'm3d.projects',
      version: 1,
      scope: 'conversation',
      history: 'latest',
      fork: 'initial',
      initial: () => ({ projects: [] }),
      checkpointWhen: () => true,
    })
    await old.setSettings({ astra, model: FAUX_A })
    await old.harness.commit(async (tx) => {
      const index = await tx.doc(ProjectsBeforePairs, old.root.id)
      index.projects.push({ id: 'old', conversation: 1, title: 'Old', createdMs: 0, ...(model === undefined ? {} : { model }) })
    }, BACKGROUND_CONTEXT)
    await old.close()
  }

  test('an unfinished turn sent with Astra goes on after the update with Astra as its helper', async () => {
    const where = scratch()
    where.keychain.set('openai-codex', CODEX_KEY)
    const first = spawnSidecar(where.data, where.projects, where.keychain, { script: 'models', env: where.env, version: '1.0.0' })
    await first.next()
    // Opus has no sign-in here, so the turn waits for one.
    const { project: id } = await first.sendDraft('new', 'go')
    await first.until((event) => event.type === 'chat' && event.project === id && event.waiting !== null)
    const { conversation } = (await projectIn(first, id)) as Project
    await first.quit()

    // The turn as an app before pairs left it: Astra offered as the `astra` tool, and no helper recorded.
    const old = await openStore(where)
    const TurnBeforePairs = defineDoc<{ turn: Turn | null }>({
      kind: 'm3d.turn',
      version: 1,
      scope: 'conversation',
      history: 'latest',
      fork: 'initial',
      initial: () => ({ turn: null }),
      checkpointWhen: () => true,
    })
    await old.harness.commit(async (tx) => {
      const { turn } = await tx.doc(TurnBeforePairs, conversation as ConversationId)
      if (turn === null) throw new Error('the turn is missing')
      delete turn.helper
      turn.tools = turn.tools.map((name) => (name === 'helper' ? 'astra' : name))
      const agent = await tx.doc(AgentDoc, conversation as ConversationId)
      agent.tools = (agent.tools as string[]).map((name) => (name === 'helper' ? 'astra' : name))
    }, BACKGROUND_CONTEXT)
    await old.close()

    const second = spawnSidecar(where.data, where.projects, where.keychain, { script: 'models', env: where.env, version: '2.0.0' })
    await second.next()
    expect((await view(second, id)).waiting).toMatchObject({ fix: 'Go on' })
    await second.call('chat.retry', { project: id })
    expect((await view(second, id)).turn).toMatchObject({ model: OPUS, helper: ASTRA, tools: ['read', 'write', 'edit', 'run', 'slice', 'helper'] })
    expect(await second.call('agent.tools', { project: id })).toContain('helper')
    await second.quit()
  })

  test('carry on with the lead they ran on and the helper the Astra setting gave them', async () => {
    for (const [astra, model, carried] of [
      [true, undefined, { model: FAUX_A, helper: ASTRA }],
      [false, FAUX_B, { model: FAUX_B, helper: null }],
    ] as const) {
      const where = scratch()
      await before(where, astra, model)
      const app = spawnSidecar(where.data, where.projects)
      await app.next()
      expect(await projectIn(app, 'old')).toMatchObject(carried)
      await app.quit()
    }
  })
})

describe('the catalog', () => {
  /** What `setup.check` names for the project's models: their sign-ins and replacements, not the build tools. */
  const needs = async (app: App, id: string) =>
    ((await app.call('setup.check', { project: id })) as Need[]).filter((need) => need.kind === 'model' || need.kind === 'login')
  /** The roles `setup.check` names as retired in this chat. */
  const retiredRoles = async (app: App, id: string) =>
    ((await app.call('setup.check', { project: id })) as Need[]).flatMap((need) => (need.kind === 'model' && need.retired !== undefined ? [need.retired.role] : []))

  test("offers a family's newest version, while a chat saved on an older one keeps it until its provider retires it", async () => {
    const where = scratch()
    where.keychain.set('openai-codex', CODEX_KEY)
    const first = await start(where, 'models')
    expect(((await first.call('models.list')) as ModelChoice[]).map((m) => m.modelId)).toEqual(['gpt-6.3-sol', 'gpt-6-astra'])
    const id = await project(first, SOL_6_1, null)
    await first.sendDraft(id, 'which model?')
    await answered(first, id, 'answered by gpt-6.1-sol')
    await first.quit()

    // The provider removes 6.1: the next turn waits, naming the lead and its replacement.
    const second = await start(where, 'models', { M3D_RETIRED: 'gpt-6.1-sol' })
    await second.sendDraft(id, 'and now?')
    const waiting = await second.until((event) => event.type === 'chat' && event.project === id && (event.waiting as { retired?: unknown } | null)?.retired !== undefined)
    expect(waiting.waiting).toEqual({
      kind: 'error',
      detail: 'GPT 6.1 Sol, the lead model, was retired by its provider.',
      fix: 'Try again',
      retired: { role: 'lead', model: SOL_6_1, replacement: SOL_6_3 },
    })
    const fix = 'GPT 6.1 Sol, the lead model, was retired. Choose GPT 6.3 Sol or another lead model.'
    expect(await needs(second, id)).toContainEqual({ kind: 'model', fix, retired: { role: 'lead', model: SOL_6_1, replacement: SOL_6_3 } })
    expect(((await second.call('models.list')) as ModelChoice[]).map((m) => m.modelId)).toEqual(['gpt-6.3-sol', 'gpt-6-astra'])
    await expect(second.call('chat.retry', { project: id })).rejects.toThrow(fix)

    await second.call('projects.setLead', { project: id, model: SOL_6_3 })
    await second.call('chat.retry', { project: id })
    await answered(second, id, 'answered by gpt-6.3-sol')
    const after = await view(second, id)
    expect(after.turn?.model).toEqual(SOL_6_3)
    // Each answer keeps the model it ran on.
    expect(answers(after.entries).map((entry) => entry.model.modelId)).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol', 'gpt-6.3-sol'])
    await second.quit()
  }, 60_000)

  test('a retired helper fails its call, then holds the next message until the person replaces it or turns it off', async () => {
    const where = scratch()
    where.keychain.set('openai-codex', CODEX_KEY)
    const app = await start(where, 'helper', { M3D_RETIRED: 'gpt-6.1-sol' })
    const id = await project(app, FAUX_A, SOL_6_1)
    await app.sendDraft(id, 'go')
    await answered(app, id, 'parent saw: GPT 6.1 Sol, the helper model, was retired by its provider.')

    const fix = 'GPT 6.1 Sol, the helper model, was retired. Choose GPT 6.3 Sol or turn the helper off.'
    expect(await needs(app, id)).toContainEqual({ kind: 'model', fix, retired: { role: 'helper', model: SOL_6_1, replacement: SOL_6_3 } })
    const { rev } = (await app.call('drafts.set', { key: id, text: 'once more', attachments: [] })) as { rev: number }
    await expect(app.call('chat.send', { key: id, rev })).rejects.toThrow(fix)

    // The removal holds this chat only: the list still offers every family, and another chat on 6.1 sends.
    const other = await project(app, FAUX_A, SOL_6_1)
    expect(await retiredRoles(app, other)).toEqual([])
    expect(((await app.call('models.list')) as ModelChoice[]).map((m) => m.modelId)).toEqual(['gpt-6.3-sol', 'gpt-6-astra'])

    await app.call('projects.setHelper', { project: id, model: null })
    await app.call('chat.send', { key: id, rev })
    expect((await view(app, id)).turn).toMatchObject({ model: FAUX_A, helper: null })
    await app.quit()
  }, 60_000)

  test('lets a chat go on with the same version once the person chooses it again, as after a misread removal', async () => {
    const where = scratch()
    where.keychain.set('openai-codex', CODEX_KEY)
    const app = await start(where, 'helper', { M3D_RETIRED: 'gpt-6.1-sol' })
    const id = await project(app, FAUX_A, SOL_6_1)
    await app.sendDraft(id, 'go')
    await answered(app, id, 'parent saw: GPT 6.1 Sol, the helper model, was retired by its provider.')
    expect(await retiredRoles(app, id)).toEqual(['helper'])
    await app.call('projects.setHelper', { project: id, model: SOL_6_1 })
    expect(await retiredRoles(app, id)).toEqual([])
    await app.quit()
  }, 60_000)

  test('names the way out of a retired role whose family has no version left to replace it', async () => {
    const store = await openStore(scratch())
    expect(store.retiredFix({ role: 'helper', model: SOL_6_1, replacement: null })).toBe(
      'GPT 6.1 Sol, the helper model, was retired. Choose another helper model or turn the helper off.',
    )
    expect(store.retiredFix({ role: 'lead', model: SOL_6_1, replacement: null })).toBe('GPT 6.1 Sol, the lead model, was retired. Choose another lead model.')
    await store.close()
  })

  test('a missing sign-in and a provider that is busy for a moment are not a retirement', async () => {
    const where = scratch()
    const app = await start(where, 'models', { M3D_FLAKY: '1' })
    await app.call('settings.set', { model: SOL_6_3 })
    const { project: unsigned } = await app.sendDraft('new', 'which model?')
    const waiting = await app.until((event) => event.type === 'chat' && event.project === unsigned && event.waiting !== null)
    expect(waiting.waiting).toMatchObject({ kind: 'login', provider: 'openai-codex' })
    expect((await needs(app, unsigned)).map((need) => need.kind)).toEqual(['login'])

    // Once signed in, the first request finds the provider overloaded, which Pi retries by itself.
    await app.call('auth.setKey', { provider: 'openai-codex', key: 'codex-key' })
    await answered(app, unsigned, 'answered by gpt-6.3-sol')
    expect(await needs(app, unsigned)).toEqual([])
    expect((await view(app, unsigned)).waiting).toBeNull()
    await app.quit()
  }, 60_000)
})
