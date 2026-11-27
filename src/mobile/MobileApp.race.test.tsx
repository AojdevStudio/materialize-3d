// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc from 'fast-check'

vi.mock('@tauri-apps/api/core', async () => (await import('./computerMock')).tauriCore())
// jsdom has no WebGL, and this chat lists no model files.
vi.mock('../studio/ModelView', () => ({ default: () => null }))
vi.mock('@tauri-apps/plugin-barcode-scanner', () => ({ Format: { QRCode: 'QR_CODE' } }))
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))
Element.prototype.scrollIntoView = () => {}

import type { ModelChoice } from '../../sidecar/src/protocol'
import { answerWithDrafts, ASTRA, computer, computerWithRoles, invoke, kept, linkIs, SOL, stream } from './computerMock'
import MobileApp from './MobileApp'
import type { LinkMessage } from './remote'

afterEach(() => {
  cleanup()
  invoke.mockReset()
  stream.heard = null
  kept.clear()
  localStorage.clear()
})

/** The same seed every run, so a failure here fails the same way on every machine and in CI. */
const SEED = 20261127

type Role = 'lead' | 'helper'
type Action =
  | { kind: 'pick'; role: Role; model: ModelChoice | null }
  | { kind: 'desktop'; role: Role; model: ModelChoice | null }
  | { kind: 'turn'; running: boolean }
  | { kind: 'drop' }
  | { kind: 'reconnect' }
  | { kind: 'screen'; to: 'Chats' | 'Refresh' | 'Shelf bracket' }

const lead = fc.constantFrom<ModelChoice>(ASTRA, SOL)
const helper = fc.constantFrom<ModelChoice | null>(ASTRA, SOL, null)
const action: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: lead.map((model) => ({ kind: 'pick', role: 'lead', model }) as const), weight: 2 },
  { arbitrary: helper.map((model) => ({ kind: 'pick', role: 'helper', model }) as const), weight: 2 },
  { arbitrary: lead.map((model) => ({ kind: 'desktop', role: 'lead', model }) as const), weight: 1 },
  { arbitrary: helper.map((model) => ({ kind: 'desktop', role: 'helper', model }) as const), weight: 1 },
  { arbitrary: fc.boolean().map((running) => ({ kind: 'turn', running }) as const), weight: 2 },
  { arbitrary: fc.constant({ kind: 'drop' } as const), weight: 1 },
  { arbitrary: fc.constant({ kind: 'reconnect' } as const), weight: 1 },
  { arbitrary: fc.constantFrom('Chats', 'Refresh', 'Shelf bracket').map((to) => ({ kind: 'screen', to }) as const), weight: 3 },
)
/** Each action, then how many held answers and events to let go before the next one. */
const steps = fc.array(fc.tuple(action, fc.nat({ max: 3 })), { minLength: 1, maxLength: 10 })

/** What a picker shows for a model: the short name, or None for no helper. */
const shownOf = (model: ModelChoice | null) => (model === null ? 'None' : model.modelId === ASTRA.modelId ? 'Astra' : 'GPT 6.1 Sol')
const menuItem = (model: ModelChoice | null) => (model === null ? 'No helper' : model.modelId === ASTRA.modelId ? 'GPT 6 Astra' : 'GPT 6.1 Sol')
// Text queries, not role queries: the checks run after every answer, and jsdom computes roles slowly.
const sendButton = () => screen.queryByText<HTMLButtonElement>('Send', { selector: 'button' })
const shownPair = () => ({ lead: screen.getByTestId('model-picker').textContent, helper: screen.getByTestId('helper-picker').textContent })
const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

/**
 * The phone with a chat, while the computer's answers and its stream's events reach it in an order the seed picks, the
 * person picks roles and goes between the chat and the list, the link drops and comes back, the desktop changes the
 * pair, and turns start and end. The computer takes each request as it comes and answers with what it holds then, and
 * only the answer is held. A stream event sent while the link is down is lost. Whatever the order:
 * 1. Send is never on while the link is down, or while the newest turn state the phone heard says a turn runs,
 * 2. Send is never on while the pickers show a pair other than the computer's, once every desktop change is one the
 *    phone could know of: its event came, the link came back after it, or a list read asked for after it came back,
 * 3. once everything landed, the pickers show the pair the computer holds, and Send is on again.
 */
it('shows the newest list read and keeps Send off while the link is down or a turn runs, whatever order the answers land in', async () => {
  /** Screen moves across every run, so a button that is never there cannot pass the checks by skipping them. */
  const moves = { Chats: 0, Refresh: 0, 'Shelf bracket': 0 }
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), steps, async (s, plan) => {
      cleanup()
      invoke.mockReset()
      stream.heard = null
      kept.clear()
      localStorage.clear()
      const broken: string[] = []
      const computerSide = computerWithRoles()
      const answer = globalThis.fetch
      let racing = false
      /** Whether the link is up, as the phone was last told. */
      let up = false
      /** The computer's turn, and the newest turn state the phone heard by `seq`, as its sender keeps it. */
      const turn = { running: false, seq: 1 }
      let heard = { ...turn }
      const hear = (told: typeof turn) => {
        if (told.seq >= heard.seq) heard = { ...told }
      }
      const chatView = (at: typeof turn) => ({ project: 'bracket', entries: [], waiting: null, turn: null, handoffs: [], ...at })
      /** Desktop changes made, and the newest one the phone could know of. */
      const desktop = { changes: 0, known: 0 }
      const know = (change: number) => (desktop.known = Math.max(desktop.known, change))
      /**
       * Counts the link's drops and returns, and the chat screen's openings and closings. A chat read answers only the
       * screen and link it was asked on, and a stream event dies with the link it was sent on.
       */
      const epochs = { link: 0, screen: 0 }

      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const path = url.replace('m3dremote://localhost/api/v1', '')
        const chatRead = path === '/chats/bracket' && init?.method === undefined
        if (!racing) return chatRead ? Response.json(chatView(turn)) : answer(url, init)
        if (!up) return new Response('The computer did not answer.', { status: 502 })
        const at = { ...turn }
        const changes = desktop.changes
        const asked = { ...epochs }
        const answered = chatRead ? Response.json(chatView(at)) : await answer(url, init)
        const delivered = await s.schedule(Promise.resolve(answered), `${init?.method ?? 'GET'} ${path}`)
        if (chatRead && asked.link === epochs.link && asked.screen === epochs.screen) hear(at)
        if (path === '/chats' && answered.ok) know(changes)
        return delivered
      })
      /** A message on the computer's stream, which reaches the phone in its turn, unless the link dropped meanwhile. */
      const streamed = (event: object, label: string, then: () => void = () => {}) => {
        const sentOn = epochs.link
        void s.schedule(Promise.resolve(), label).then(() => {
          if (!up || epochs.link !== sentOn) return
          then()
          stream.heard?.({ kind: 'event', event } as LinkMessage)
        })
      }

      answerWithDrafts({ paired_computer: computer })
      render(<MobileApp />)
      await linkIs({ kind: 'connected' })
      up = true
      fireEvent.click(await screen.findByRole('button', { name: 'Shelf bracket' }))
      await waitFor(() => expect(screen.getByTestId('model-picker').hasAttribute('disabled')).toBe(false))
      fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Make it thicker' } })
      await waitFor(() => expect(sendButton()?.disabled).toBe(false))
      racing = true

      const check = (when: string) => {
        const send = sendButton()
        if (send === null || send.disabled) return
        if (!up) broken.push(`Send on while the link is down, ${when}`)
        if (heard.running) broken.push(`Send on while turn ${heard.seq} runs, ${when}`)
        if (desktop.known < desktop.changes) return
        const pair = shownPair()
        const held = computerSide.roles()
        if (pair.lead !== shownOf(held.lead) || pair.helper !== shownOf(held.helper))
          broken.push(`Send on with ${pair.lead} and ${pair.helper} shown, the computer holds ${shownOf(held.lead)} and ${shownOf(held.helper)}, ${when}`)
      }
      const run = async (step: Action) => {
        switch (step.kind) {
          case 'pick': {
            if (screen.queryByTestId('model-picker') === null) return
            fireEvent.click(screen.getByTestId(step.role === 'lead' ? 'model-picker' : 'helper-picker'))
            const menu = screen.queryByRole('menu', { name: step.role === 'lead' ? 'Lead models' : 'Helper models' })
            if (menu !== null) fireEvent.click(within(menu).getByRole('menuitemradio', { name: menuItem(step.model) }))
            return
          }
          case 'desktop': {
            computerSide.desktopSets(step.role === 'lead' && step.model !== null ? { lead: step.model } : { helper: step.model })
            const change = ++desktop.changes
            streamed({ type: 'project', project: { id: 'bracket' } }, `desktop change ${change} event`, () => know(change))
            return
          }
          case 'turn': {
            turn.seq += 1
            turn.running = step.running
            const at = { ...turn }
            streamed({ type: 'chat', ...chatView(at) }, `turn ${at.seq} ${at.running ? 'runs' : 'ends'}`, () => hear(at))
            return
          }
          case 'drop':
            if (!up) return
            up = false
            epochs.link += 1
            await act(async () => stream.heard?.({ kind: 'offline', detail: 'The computer did not answer.' }))
            return
          case 'reconnect':
            if (up) return
            up = true
            epochs.link += 1
            know(desktop.changes)
            await act(async () => stream.heard?.({ kind: 'connected' }))
            return
          case 'screen': {
            const button = screen.queryByRole('button', { name: step.to })
            if (button === null) return
            epochs.screen += 1
            moves[step.to] += 1
            fireEvent.click(button)
            const shows = step.to === 'Shelf bracket' ? screen.queryByLabelText('Message') : screen.queryByRole('button', { name: 'Refresh' })
            if (shows === null) broken.push(`${step.to} did not show its screen`)
            return
          }
        }
      }
      // A held answer lands, and what it sets off runs and draws before the check.
      const letGo = async () => {
        await act(async () => {
          await s.waitOne()
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
        check('after an answer landed')
      }

      for (const [step, released] of plan) {
        await run(step)
        await act(async () => {})
        check(`after ${step.kind}`)
        for (let i = 0; i < released && s.count() > 0; i += 1) await letGo()
      }
      // The link comes back and the turn ends, and everything still held lands.
      await run({ kind: 'reconnect' })
      await run({ kind: 'turn', running: false })
      await run({ kind: 'screen', to: 'Shelf bracket' })
      for (let quiet = false; !quiet; ) {
        while (s.count() > 0) await letGo()
        await pause(20)
        quiet = s.count() === 0
      }

      expect(broken).toEqual([])
      const held = computerSide.roles()
      expect(shownPair()).toEqual({ lead: shownOf(held.lead), helper: shownOf(held.helper) })
      expect(sendButton()?.disabled).toBe(false)
      cleanup()
    }),
    { seed: SEED, numRuns: 60 },
  )
  expect(Object.entries(moves).flatMap(([to, count]) => (count === 0 ? [to] : []))).toEqual([])
}, 240_000)
