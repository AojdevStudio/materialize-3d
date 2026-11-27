import { vi, expect } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { ModelChoice } from '../../sidecar/src/protocol'
import type { DeviceDraft, LinkMessage } from './remote'

/**
 * The phone's Tauri side and the paired computer, mocked, for the tests that render `MobileApp`. Each test file mocks
 * `@tauri-apps/api/core` with `tauriCore`, so they all share one device and one link.
 */

export const invoke = vi.fn()
export const stream = { heard: null as ((message: LinkMessage) => void) | null }

/** A `vi.mock` factory for `@tauri-apps/api/core`. Rust's link watcher hands the window a channel's messages, and each test says what the link does. */
export const tauriCore = () => ({
  invoke,
  Channel: class {
    constructor(heard: (message: LinkMessage) => void) {
      stream.heard = heard
    }
  },
})

export const computer = { id: 'a70bf50e531ce1a8', name: 'Studio Mac', origin: 'https://studio.tail1234.ts.net:47380/' }

/** The drafts this device keeps, by chat, as Rust's draft files hold them across launches. */
export const kept = new Map<string, DeviceDraft>()
/** Rust's answer to a draft load, when it cannot read the file, and to a draft save, when it cannot write it or the test holds it. */
export const device = {
  loadFails: null as string | null,
  saveFails: null as string | null,
  saveWaits: null as Promise<void> | null,
  forgetFails: null as string | null,
  forgetWaits: null as Promise<void> | null,
}

export function answerWithDrafts(commands: Record<string, unknown>) {
  invoke.mockImplementation(async (command: string, args: { project: string; draft: DeviceDraft }) => {
    if (command === 'draft_load') {
      if (device.loadFails !== null) throw device.loadFails
      return kept.get(args.project) ?? null
    }
    if (command === 'draft_save') {
      const waits = device.saveWaits
      device.saveWaits = null
      await waits
      if (device.saveFails !== null) throw device.saveFails
      const empty = args.draft.text === '' && args.draft.pictures.length === 0 && args.draft.sent === null
      if (empty) kept.delete(args.project)
      else kept.set(args.project, args.draft)
      return
    }
    // Rust removes every draft when the device forgets its computer.
    if (command === 'forget') {
      await device.forgetWaits
      if (device.forgetFails !== null) throw device.forgetFails
      return kept.clear()
    }
    return commands[command]
  })
}

/**
 * Hands the link watcher a message. A screen makes its watcher in an effect, which can run after its first render
 * shows, so this waits for the watcher first.
 */
export async function linkIs(message: LinkMessage) {
  await waitFor(() => expect(stream.heard).not.toBeNull())
  await act(() => stream.heard?.(message))
}

export const ASTRA = { provider: 'openai-codex', modelId: 'gpt-6-astra' }
export const SOL = { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }
const status = { running: false, printed: false, printFiles: 0, lastMs: 0 }

/**
 * A computer with one chat whose pair a PUT changes. Each request on a path in `hold` waits until the test lets the
 * oldest held one answer. A role save that `refuse` names is refused, and the pair stays. `log` lists every write as
 * it reaches the computer, `saves` the role saves it took, and `roles` the pair it holds now.
 */
export function computerWithRoles(hold: string[] = [], refuse: (change: object) => boolean = () => false, failLists = { next: 0 }) {
  const roles = { lead: SOL as ModelChoice, helper: ASTRA as ModelChoice | null }
  const saves: unknown[] = []
  const log: string[] = []
  const waiting: (() => void)[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = url.replace('m3dremote://localhost/api/v1', '')
    if (init?.method !== undefined) log.push(`${init.method} ${path}`)
    if (hold.includes(path)) await new Promise<void>((resolve) => waiting.push(resolve))
    if (init?.method === 'PUT' && path === '/chats/bracket/roles') {
      const change = JSON.parse(String(init.body)) as Partial<typeof roles>
      if (refuse(change)) return Response.json({ error: 'GPT 6 Astra was retired by its provider.' }, { status: 400 })
      saves.push(change)
      Object.assign(roles, change)
      return Response.json(roles)
    }
    if (init?.method === 'PUT' && path === '/chats/bracket/draft') return Response.json({ rev: 1 })
    if (init?.method === 'POST' && path === '/chats/bracket/send') return Response.json({ project: { id: 'bracket' } })
    if (path === '/chats' && failLists.next > 0) {
      failLists.next -= 1
      return new Response('The chat list could not be read.', { status: 500 })
    }
    if (path === '/chats') return Response.json([{ id: 'bracket', title: 'Shelf bracket', createdMs: 0, ...roles, status }])
    if (path === '/chats/bracket') return Response.json({ project: 'bracket', entries: [], running: false, waiting: null, turn: null, handoffs: [], seq: 1 })
    if (path === '/chats/bracket/files') return Response.json([])
    if (path === '/models') return Response.json([{ ...ASTRA, name: 'GPT 6 Astra', description: '' }, { ...SOL, name: 'GPT 6.1 Sol', description: '' }])
    return new Response('Not found', { status: 404 })
  })
  /** A pair the desktop saved on the computer. */
  const desktopSets = (change: Partial<typeof roles>) => Object.assign(roles, change)
  return { saves, log, answerNext: () => waiting.shift()?.(), desktopSets, roles: () => ({ ...roles }) }
}
