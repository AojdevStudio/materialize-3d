import { describe, expect, it, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { createRegistry, defineDoc } from '@earendil-works/pi-durable'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { type AppState, EXIT, type Settings, type Setup } from '../src/protocol'
import { DraftsDoc, openStorage, SettingsDoc, Store } from '../src/store'
import { spawnSidecar } from './sidecar'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-store-'))
  return { data: join(dir, 'state'), projects: join(dir, 'projects') }
}

// Pi's own storage conformance suite, against the storage the store opens, on this runtime.
registerStorageConformance({ describe, expect, it }, 'the store on Bun SQLite', async (use) => {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-conformance-'))
  const storage = await openStorage(join(dir, 'store.sqlite'))
  try {
    await use(storage)
  } finally {
    await storage.close(BACKGROUND_CONTEXT)
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('one writer', () => {
  test('a second sidecar on the same store is refused, and a crashed owner frees it', async () => {
    const { data, projects } = scratch()
    const first = spawnSidecar(data, projects)
    expect(await first.next()).toMatchObject({ kind: 'event', event: { type: 'ready' } })

    const second = spawnSidecar(data, projects)
    expect(await second.child.exited).toBe(EXIT.storeInUse)
    expect(await second.stderr()).toContain('Another copy of Materialize 3D owns the store.')

    first.child.kill('SIGKILL')
    await first.child.exited
    const third = spawnSidecar(data, projects)
    expect(await third.next()).toMatchObject({ kind: 'event', event: { type: 'ready' } })
    expect(await third.quit()).toBe(EXIT.done)
  })
})

describe('app state', () => {
  test('setup progress, settings, projects, and drafts survive a quit and a crash', async () => {
    const { data, projects } = scratch()
    const app = spawnSidecar(data, projects)
    await app.next()
    await app.call('setup.set', { step: 'printer', done: false })
    await app.call('settings.set', { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' } })
    const project = { id: (await app.sendDraft('new', 'A wall mount for my dock\nfrom a photo')).project }
    await app.call('drafts.set', { key: project.id, text: 'Make it 2 mm thicker', attachments: ['/Users/me/dock.jpg'] })
    const before = await app.call('state.get')
    expect(before).toMatchObject({
      setup: { step: 'printer', done: false },
      settings: { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' }, thinking: 'high' },
      projects: [{ id: project.id, title: 'A wall mount for my dock' }],
      drafts: { [project.id]: { text: 'Make it 2 mm thicker', attachments: ['/Users/me/dock.jpg'] } },
    })
    expect(existsSync(join(projects, project.id))).toBe(true)
    expect(await app.quit()).toBe(EXIT.done)

    const reopened = spawnSidecar(data, projects)
    await reopened.next()
    expect(await reopened.call('state.get')).toEqual(before)
    await reopened.call('setup.set', { step: 'ready', done: true })
    reopened.child.kill('SIGKILL')
    await reopened.child.exited

    const afterCrash = spawnSidecar(data, projects)
    await afterCrash.next()
    expect(await afterCrash.call('state.get')).toEqual({ ...(before as object), setup: { step: 'ready', done: true } })
    await afterCrash.quit()
  })

  test('the app state is read at one point in the store, never half before and half after a commit', async () => {
    const { data, projects } = scratch()
    const app = spawnSidecar(data, projects)
    await app.next()
    for (let round = 0; round < 20; round++) {
      const { rev } = (await app.call('drafts.set', { key: 'new', text: `Knob ${round}`, attachments: [] })) as { rev: number }
      // The read goes out right behind the send, whose first commit makes the project and moves the draft, without
      // waiting for it.
      app.send({ kind: 'call', id: 1000 + round, method: 'chat.send', params: { key: 'new', rev } })
      app.send({ kind: 'call', id: 2000 + round, method: 'state.get', params: {} })
      const replies = new Map<number, unknown>()
      while (replies.size < 2) {
        const message = await app.next()
        if (message?.kind === 'reply') replies.set(message.id as number, message.value)
      }
      const { id } = (replies.get(1000 + round) as { project: { id: string } }).project
      const state = replies.get(2000 + round) as { projects: { id: string }[]; drafts: Record<string, { text: string }> }
      const made = state.projects.some((p) => p.id === id)
      // Before that commit: no project, the draft on the start screen. After it: the project holds the draft until the
      // message goes out, and the start screen holds none.
      expect(made ? state.drafts.new : state.drafts.new?.text).toEqual(made ? undefined : `Knob ${round}`)
      if (made) expect([undefined, `Knob ${round}`]).toContain(state.drafts[id]?.text)
      else expect(state.drafts[id]).toBeUndefined()
    }
    await app.quit()
  })

  test('a project whose folder cannot be made is not made at all, and the start screen keeps its draft', async () => {
    const { data, projects } = scratch()
    // A file where the projects folder goes, so no project folder can be made.
    writeFileSync(projects, '')
    const app = spawnSidecar(data, projects)
    await app.next()
    await expect(app.sendDraft('new', 'A knob')).rejects.toThrow()
    expect(await app.call('state.get')).toMatchObject({ projects: [], drafts: { new: { text: 'A knob', attachments: [] } } })
    await app.quit()
  })

  test('a new project never takes the folder of one already on disk', async () => {
    const { data, projects } = scratch()
    const app = spawnSidecar(data, projects)
    await app.next()
    const first = await app.sendDraft('new', 'A knob')
    // A folder the store does not list, such as one an older app made, under the id the next project would take.
    mkdirSync(join(projects, `${first.project}-2`), { recursive: true })
    const second = await app.sendDraft('new', 'A knob')
    expect(second.project).toBe(`${first.project}-3`)
    await app.quit()
  })

  test('a store from v0.3.0 counts as set up and still opens in v0.3.0, and a new store starts setup at Welcome', async () => {
    const before = scratch()
    const open = () =>
      Store.open({
        dataDir: before.data,
        projectsDir: before.projects,
        models: createModels({ credentials: new InMemoryCredentialStore() }),
        registry: createRegistry(),
        env: () => {
          throw new Error('no conversation runs here')
        },
      })
    // v0.3.0 wrote this document on every state read and never changed it.
    const SetupBeforeSetup = defineDoc<Setup>({
      kind: 'm3d.setup',
      version: 1,
      scope: 'conversation',
      history: 'latest',
      fork: 'initial',
      initial: () => ({ step: 'welcome', done: false }),
      checkpointWhen: () => true,
    })
    const readAsV030 = async () => {
      const store = await open()
      const setup = await store.harness.commit(async (tx) => ({ ...(await tx.doc(SetupBeforeSetup, store.root.id)) }), BACKGROUND_CONTEXT)
      await store.close()
      return setup
    }
    expect(await readAsV030()).toEqual({ step: 'welcome', done: false })

    const updated = spawnSidecar(before.data, before.projects)
    await updated.next()
    expect(((await updated.call('state.get')) as { setup: Setup }).setup.done).toBe(true)
    await updated.quit()
    expect(await readAsV030()).toEqual({ step: 'welcome', done: false })

    const fresh = scratch()
    const app = spawnSidecar(fresh.data, fresh.projects)
    await app.next()
    expect(((await app.call('state.get')) as { setup: Setup }).setup).toEqual({ step: 'welcome', done: false })
    await app.quit()
  })

  test('settings saved before the Astra setting keep Astra on', async () => {
    const { data, projects } = scratch()
    const old = await Store.open({
      dataDir: data,
      projectsDir: projects,
      models: createModels({ credentials: new InMemoryCredentialStore() }),
      registry: createRegistry(),
      env: () => {
        throw new Error('no conversation runs here')
      },
    })
    await old.harness.commit(async (tx) => {
      delete (await tx.doc(SettingsDoc, old.root.id) as Partial<Settings>).astra
    }, BACKGROUND_CONTEXT)
    await old.close()

    const app = spawnSidecar(data, projects)
    await app.next()
    expect(((await app.call('state.get')) as AppState).settings.astra).toBe(true)
    await app.quit()
  })

  test('a draft saved before drafts had revisions gets one at start, so its send takes it away', async () => {
    const { data, projects } = scratch()
    const old = await Store.open({
      dataDir: data,
      projectsDir: projects,
      models: createModels({ credentials: new InMemoryCredentialStore() }),
      registry: createRegistry(),
      env: () => {
        throw new Error('no conversation runs here')
      },
    })
    await old.harness.commit(async (tx) => {
      // A draft as a store from before revisions holds it.
      ;((await tx.doc(DraftsDoc, old.root.id)).drafts as Record<string, { text: string; attachments: string[] }>).new = { text: 'A knob', attachments: [] }
    }, BACKGROUND_CONTEXT)
    await old.close()

    const app = spawnSidecar(data, projects)
    await app.next()
    const { drafts } = (await app.call('state.get')) as { drafts: Record<string, { text: string; attachments: string[]; rev?: number }> }
    expect(drafts.new).toEqual({ text: 'A knob', attachments: [], rev: expect.any(Number) })
    await app.call('chat.send', { key: 'new', rev: drafts.new?.rev })
    expect(((await app.call('state.get')) as { drafts: object }).drafts).toEqual({})
    await app.quit()
  })
})
