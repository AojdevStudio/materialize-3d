import { describe, expect, it, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { EXIT } from '../src/protocol'
import { openStorage } from '../src/store'
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
    expect(await new Response(second.child.stderr).text()).toContain('Another copy of Materialize 3D owns the store.')

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
    await app.call('drafts.set', { key: 'new', text: 'A wall mount for my dock', attachments: [] })
    await app.call('setup.set', { step: 'printer', done: false })
    await app.call('settings.set', { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' } })
    const project = (await app.call('projects.create', { title: 'A wall mount for my dock\nfrom a photo' })) as { id: string }
    await app.call('drafts.set', { key: project.id, text: 'Make it 2 mm thicker', attachments: ['refs/dock.jpg'] })
    const before = await app.call('state.get')
    expect(before).toMatchObject({
      setup: { step: 'printer', done: false },
      settings: { model: { provider: 'openai-codex', modelId: 'gpt-6-astra' }, thinking: 'high' },
      projects: [{ id: project.id, title: 'A wall mount for my dock' }],
      drafts: { [project.id]: { text: 'Make it 2 mm thicker', attachments: ['refs/dock.jpg'] } },
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

  test('a project made from the start screen takes the start screen draft with it', async () => {
    const { data, projects } = scratch()
    const app = spawnSidecar(data, projects)
    await app.next()
    await app.call('drafts.set', { key: 'new', text: 'A knob', attachments: ['refs/shaft.png'] })
    const project = (await app.call('projects.create', { title: 'A knob' })) as { id: string }
    expect(((await app.call('state.get')) as { drafts: object }).drafts).toEqual({ [project.id]: { text: 'A knob', attachments: ['refs/shaft.png'] } })
    await app.quit()
  })
})
