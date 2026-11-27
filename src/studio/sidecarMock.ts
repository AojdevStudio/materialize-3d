import { vi } from 'vitest'
import { act } from '@testing-library/react'
import type { Project } from '../../sidecar/src/protocol'
import type { ProjectFile } from './api'

/**
 * The desktop window's Tauri side and its sidecar, mocked, for the tests that render `StudioApp`. Each test file mocks
 * the Tauri modules with the factories below, so they all share one mocked sidecar.
 */

type Listener = (event: { payload: unknown }) => void
export const invokeMock = vi.fn()
export const listeners = { sidecar: [] as Listener[], drop: [] as Listener[], flush: [] as Listener[] }

/** `vi.mock` factories for the Tauri modules the window imports. */
export const tauriCore = () => ({ invoke: invokeMock })
export const tauriEvent = () => ({
  listen: (name: string, listener: Listener) => {
    ;(name === 'studio://flush' ? listeners.flush : listeners.sidecar).push(listener)
    return Promise.resolve(() => {})
  },
})
export const tauriWebview = () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (listener: Listener) => {
      listeners.drop.push(listener)
      return Promise.resolve(() => {})
    },
  }),
})

/** Forgets every call and listener, so the next render starts clean. */
export function resetSidecar() {
  invokeMock.mockReset()
  listeners.sidecar.length = 0
  listeners.drop.length = 0
  listeners.flush.length = 0
}

export const projectA = { id: '2026-11-06-a', conversation: 2, title: 'Project A', createdMs: 2, model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, helper: null, roles: 0 }
export const projectB = { id: '2026-11-06-b', conversation: 3, title: 'Project B', createdMs: 1, model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, helper: null, roles: 0 }
export const view = (project: string, more: object = {}) => ({ project, entries: [], running: false, waiting: null, turn: null, handoffs: [], seq: 1, ...more })
export const settings = { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, thinking: 'high', printer: { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PETG Basic @BBL P2S' } }
export const models = [
  { provider: 'anthropic', modelId: 'claude-opus-5-5', name: 'Opus 5.5' },
  { provider: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { provider: 'openai-codex', modelId: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' },
]

/** An event from the sidecar, as Rust forwards it to the window. */
export const emit = (event: object) => act(() => listeners.sidecar.forEach((listener) => listener({ payload: event })))

export type Params = Record<string, unknown>
/** A call's own answer from the mocked sidecar, which an override may hold, fail, or pass on. */
export type Calls = Record<string, (params: Params, real: () => Promise<unknown>) => Promise<unknown>>
/** The revisions the mocked sidecar gives saved drafts. */
export let draftRevs = 0

export const LOST = 'The engine restarted before it answered. Try again.'

/** Holds each call until `release`, then answers as the mocked sidecar would. */
export function held() {
  let release = () => {}
  return {
    call: (_: Params, real: () => Promise<unknown>) => new Promise((resolve) => (release = () => resolve(real()))),
    release: () => act(async () => release()),
  }
}

/** The project a send from the start screen makes. */
export const made = { id: '2026-11-06-a-clip', conversation: 10, title: 'A clip', createdMs: 10, model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, helper: null, roles: 0 }

/**
 * The sidecar as the window sees it: one `sidecar` command, by method. A save answers a new revision, and a send
 * answers the project it went to: `made` for the start screen. The draft and send rules are the sidecar's own, tested in
 * `sidecar/test/send.test.ts`, and the window's side of them in `drafts.test.tsx`. It answers the default model the
 * start screen's picker sets, for a test to read.
 */
export function mockSidecar(overrides: Calls = {}, projects: Project[] = [projectB], drafts: Record<string, { text: string; attachments?: string[] }> = {}, files: Record<string, ProjectFile[]> = {}) {
  const store = {
    projects: [...projects],
    drafts: Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, { text: draft.text, attachments: draft.attachments ?? [], rev: ++draftRevs }])),
    model: settings.model,
  }
  const defaults = (method: string, params: Params): Promise<unknown> => {
    switch (method) {
      case 'app.ping':
        return Promise.resolve({ version: '1.2.3' })
      case 'state.get':
        return Promise.resolve(
          JSON.parse(JSON.stringify({ setup: { step: 'ready', done: true }, settings: { ...settings, model: store.model }, projects: store.projects, drafts: store.drafts, importBlocked: null })),
        )
      case 'settings.set':
        store.model = params.model as typeof settings.model
        return defaults('state.get', {})
      case 'projects.setLead':
      case 'projects.setHelper': {
        // As the sidecar does: save the role, then tell every window the project changed.
        const change = method === 'projects.setLead' ? { model: params.model as typeof settings.model } : { helper: params.model as typeof settings.model | null }
        store.projects = store.projects.map((p) => (p.id === params.project ? { ...p, ...change, roles: p.roles + 1 } : p))
        const saved = store.projects.find((p) => p.id === params.project)
        listeners.sidecar.forEach((listener) => listener({ payload: { type: 'project', project: saved } }))
        return Promise.resolve(saved)
      }
      case 'chat.open':
        return Promise.resolve(view(String(params.project)))
      case 'setup.check':
        return Promise.resolve([])
      case 'setup.tools':
        return Promise.resolve({ uv: '0.9.2', python: '3.12.1' })
      case 'auth.status':
        return Promise.resolve([
          { provider: 'anthropic', name: 'Anthropic', login: 'api_key', kinds: ['api_key', 'oauth'] },
          { provider: 'openai-codex', name: 'ChatGPT', login: null, kinds: ['oauth'] },
        ])
      case 'models.list':
        return Promise.resolve(models)
      case 'projects.status':
        return Promise.resolve({})
      case 'drafts.set':
        return Promise.resolve({ rev: ++draftRevs })
      case 'chat.send': {
        // A start screen send makes its project with the pair it carries, which the store then holds, as the sidecar's
        // does.
        const pair = params.pair as { lead?: typeof settings.model; helper?: typeof settings.model | null } | undefined
        if (params.key === 'new' && !store.projects.some((p) => p.id === made.id)) {
          store.projects = [pair === undefined ? made : { ...made, model: pair.lead ?? store.model, helper: pair.helper ?? null, roles: 1 }, ...store.projects]
        }
        return Promise.resolve({ project: store.projects.find((p) => p.id === (params.key === 'new' ? made.id : params.key)) })
      }
      default:
        return Promise.resolve(null)
    }
  }
  invokeMock.mockImplementation((command: string, args: { method: string; params: Params; project?: string }) => {
    if (command === 'update_check') return Promise.resolve({ status: 'upToDate' })
    if (command === 'studio_files') return Promise.resolve(files[String(args.project)] ?? [])
    if (command === 'studio_slicer') {
      const found = () => Promise.resolve({ found: 'ready', version: '02.08.02.61' })
      return overrides.studio_slicer?.({}, found) ?? found()
    }
    if (command !== 'sidecar') return Promise.resolve(undefined)
    const real = () => defaults(args.method, args.params)
    const override = overrides[args.method]
    return override ? override(args.params, real) : real()
  })
  return store
}

export const sidecarCalls = (method: string) =>
  invokeMock.mock.calls.filter(([command, args]) => command === 'sidecar' && args.method === method).map(([, args]) => args.params)
