import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { createRegistry } from '@earendil-works/pi-durable'
import { Host } from '../src/host'
import { legacyProjects } from '../src/legacy'
import { handlers, type Services } from '../src/methods'
import {
  EXIT,
  FLAGS,
  type HostRequest,
  KEPT_ENV,
  META_DIR,
  PICTURES_FOLDER,
  PLATES,
  PROVIDERS,
  SKIPPED,
  type SidecarEvent,
} from '../src/protocol'
import { skipped } from '../src/folder'
import { Store } from '../src/store'
import contract from './fixtures/contract.json'

// `src-tauri` checks Rust's side against the same file.

describe('the contract with Rust', () => {
  test('names the values the sidecar defines', () => {
    const hostRequests = {
      'keychain.get': true,
      'keychain.set': true,
      'keychain.delete': true,
      'printer.check': true,
      slice: true,
      busy: true,
    } satisfies Record<HostRequest, true>
    expect(contract.hostRequests).toEqual(Object.keys(hostRequests))
    expect(contract.flags).toEqual({ appVersion: `--${FLAGS.appVersion}`, data: `--${FLAGS.data}`, projects: `--${FLAGS.projects}` })
    expect(contract.folders.pictures).toBe(PICTURES_FOLDER)
    expect(contract.env).toEqual([...KEPT_ENV])
    expect(contract.exit).toEqual(EXIT)
    expect(contract.providers).toEqual([...PROVIDERS])
    expect(contract.metaDir).toBe(META_DIR)
    expect(contract.skipped.names).toEqual([...SKIPPED])
    expect(contract.plates).toEqual([...PLATES])
  })

  test('holds the engine events Rust sends the window', () => {
    const events: Extract<SidecarEvent, { type: 'engine' }>[] = [
      { type: 'engine', state: 'restarting', detail: 'the engine exited with exit status: 1' },
      { type: 'engine', state: 'stopped', detail: 'Another copy of Materialize 3D is open. Quit it, then open this one again.' },
    ]
    expect(contract.engineEvents).toEqual(events)
  })

  test('skips the names the file list skips', () => {
    expect(contract.skipped.samples.skipped.filter((name) => !skipped(name))).toEqual([])
    expect(contract.skipped.samples.listed.filter(skipped)).toEqual([])
  })

  test('holds only printers the sidecar takes', () => {
    // The params schema takes exactly what `Printer` names, as protocol.test.ts checks. Building it reads no service.
    const { params } = handlers({} as Services)['printer.set']
    for (const printer of contract.printers) expect(params.errors(printer)).toEqual([])
  })

  test('writes the lines the sidecar writes, and reads the lines Rust writes', async () => {
    const written: unknown[] = []
    const host = new Host((line) => written.push(JSON.parse(line)))
    host.emit({ type: 'ready', version: '1.2.3' })
    host.emit({ type: 'login', provider: 'anthropic', step: 'done' })
    const got = host.request('keychain.get', { account: 'anthropic' })
    const deleted = host.request('keychain.delete', { account: 'anthropic' })
    const methods = { 'app.ping': handlers({ version: '1.2.3' } as Services)['app.ping'] }
    await host.serve(methods, Readable.from(contract.lines.fromRust.map((line) => `${line}\n`)))
    expect(await got).toEqual({ secret: null })
    await expect(deleted).rejects.toThrow('locked')
    expect(written).toEqual(contract.lines.fromSidecar.map((line) => JSON.parse(line)))
  })

  test('fails on a line from Rust that is not a protocol line', async () => {
    for (const line of contract.lines.bad) {
      const host = new Host(() => {})
      await expect(host.serve({}, Readable.from([`${line}\n`]))).rejects.toThrow()
    }
  })
})

describe('project ids', () => {
  let dir: string
  let store: Store

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'm3d-contract-'))
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

  test('are the date and the slug of the title, as Rust takes them', async () => {
    const now = new Date()
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
    for (const { title, slug } of contract.projects.made) {
      const rev = await store.setDraft('new', { text: title, attachments: [] })
      expect((await store.startProject(rev, undefined, null)).project.id).toBe(`${today}-${slug}`)
    }
  })

  test('of chats from before the store are their folder names', () => {
    const { found } = legacyProjects(join(import.meta.dir, 'fixtures', 'legacy'), new Set())
    expect(found.map((project) => project.id)).toEqual(contract.projects.imported)
  })
})
