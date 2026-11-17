import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState, Login, Plate, Printer, Setup, Thinking } from '../src/protocol'
import { spawnSidecar } from './sidecar'

// The method table is built from the real store, logins, and chats, so its params are checked at the pipe, as the
// window's calls are.
let app: ReturnType<typeof spawnSidecar>
const checked: Printer[] = []

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3d-methods-'))
  app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), new Map(), {
    rust: {
      'printer.check': (params) => {
        checked.push(params as Printer)
        return null
      },
    },
  })
  expect(await app.next()).toMatchObject({ kind: 'event', event: { type: 'ready' } })
})

afterAll(async () => {
  await app.quit()
})

/** The error a call was refused with, or null when it was answered. */
const refusal = (method: string, params: unknown) =>
  app.call(method, params).then(
    () => null,
    (error: Error) => error.message,
  )

const STEPS: Setup['step'][] = ['welcome', 'check', 'model', 'printer', 'ready']
const THINKING: Thinking[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const PLATES: Plate[] = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Supertack Plate']
const PROVIDERS = ['anthropic', 'openai-codex', 'opencode-go'] as const
const p2s = { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PETG Basic @BBL P2S' }

describe('the params each method takes', () => {
  test('setup.set takes each setup step and refuses another', async () => {
    for (const step of STEPS) expect(((await app.call('setup.set', { step, done: false })) as AppState).setup).toEqual({ step, done: false })
    expect(await refusal('setup.set', { step: 'done', done: true })).toStartWith('bad params for setup.set: ')
  })

  test('settings.set takes each thinking level and refuses another', async () => {
    for (const thinking of THINKING) expect(((await app.call('settings.set', { thinking })) as AppState).settings.thinking).toBe(thinking)
    expect(await refusal('settings.set', { thinking: 'ultra' })).toStartWith('bad params for settings.set: ')
  })

  test('printer.set takes each plate or none, asks Rust to check the printer, and refuses another plate', async () => {
    checked.length = 0
    for (const plate of PLATES) expect(((await app.call('printer.set', { ...p2s, plate })) as AppState).settings.printer).toEqual({ ...p2s, plate })
    expect(((await app.call('printer.set', p2s)) as AppState).settings.printer).toEqual(p2s)
    expect(checked).toEqual([...PLATES.map((plate) => ({ ...p2s, plate })), p2s])

    expect(await refusal('printer.set', { ...p2s, plate: 'Smooth PEI Plate' })).toStartWith('bad params for printer.set: ')
    expect(await refusal('printer.set', { ...p2s, machine: '' })).toStartWith('bad params for printer.set: ')
    expect(checked).toHaveLength(PLATES.length + 1)
  })

  test('each auth method takes each provider and refuses another', async () => {
    for (const provider of PROVIDERS) {
      expect((await app.call('auth.logout', { provider })) as Login[]).toContainEqual(expect.objectContaining({ provider, login: null }))
      expect(await refusal('auth.answer', { provider, text: 'yes' })).toBe(`${provider} is not asking for anything`)
    }
    for (const [method, params] of [
      ['auth.setKey', { provider: 'openai', key: 'sk-test' }],
      ['auth.login', { provider: 'openai' }],
      ['auth.answer', { provider: 'openai', text: 'yes' }],
      ['auth.logout', { provider: 'openai' }],
    ] as const) {
      expect(await refusal(method, params)).toStartWith(`bad params for ${method}: `)
    }
  })

  test('a method the table does not hold is refused by name', async () => {
    expect(await refusal('projects.delete', {})).toBe('no method projects.delete')
  })
})
