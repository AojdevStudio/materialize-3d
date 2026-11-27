// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc from 'fast-check'

vi.mock('@tauri-apps/api/core', async () => (await import('./sidecarMock')).tauriCore())
vi.mock('@tauri-apps/api/event', async () => (await import('./sidecarMock')).tauriEvent())
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve() }))
vi.mock('@tauri-apps/api/webview', async () => (await import('./sidecarMock')).tauriWebview())

import type { ModelChoice, SentRoles } from '../../sidecar/src/protocol'
import { invokeMock, listeners, mockSidecar, models, projectA, projectB, resetSidecar, sidecarCalls, type Params } from './sidecarMock'
import StudioApp from './StudioApp'

Element.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  cleanup()
  resetSidecar()
  window.localStorage.clear()
})

/** The same seed every run, so a failure here fails the same way on every machine and in CI. */
const SEED = 20261127

type Role = 'lead' | 'helper'
type Name = (typeof models)[number]['name']
/** What a picker shows: a model's short name, or None for no helper. */
type Shown = Name | 'None'
type Action =
  | { kind: 'pick'; role: Role; name: Shown }
  | { kind: 'send' }
  | { kind: 'phone'; role: Role; name: Shown }
  | { kind: 'restart' }
  | { kind: 'quit' }

const names = models.map((m) => m.name)
const shownOf = (model: ModelChoice | null): Shown => (model === null ? 'None' : (models.find((m) => m.modelId === model.modelId)?.name ?? model.modelId))
const modelOf = (name: Shown): ModelChoice | null => {
  const model = models.find((m) => m.name === name)
  return model === undefined ? null : { provider: model.provider, modelId: model.modelId }
}

const leadName = fc.constantFrom(...names)
const helperName = fc.constantFrom<Shown>(...names, 'None')
const action: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: leadName.map((name) => ({ kind: 'pick', role: 'lead', name }) as const), weight: 2 },
  { arbitrary: helperName.map((name) => ({ kind: 'pick', role: 'helper', name }) as const), weight: 3 },
  { arbitrary: fc.constant({ kind: 'send' } as const), weight: 3 },
  { arbitrary: leadName.map((name) => ({ kind: 'phone', role: 'lead', name }) as const), weight: 1 },
  { arbitrary: helperName.map((name) => ({ kind: 'phone', role: 'helper', name }) as const), weight: 1 },
  { arbitrary: fc.constant({ kind: 'restart' } as const), weight: 1 },
  { arbitrary: fc.constant({ kind: 'quit' } as const), weight: 2 },
)
/** Each action, then how many held replies and events to let go before the next one. */
const steps = fc.array(fc.tuple(action, fc.nat({ max: 3 })), { minLength: 1, maxLength: 10 })

const shown = () => ({ lead: screen.getByTestId('model-picker').textContent, helper: screen.getByTestId('helper-picker').textContent })
const prompt = () => screen.getByTestId('prompt') as HTMLTextAreaElement
const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

/** Clicks a picker and the item for `name`, or answers false when the picker offers no menu now. */
function pick(role: Role, name: Shown) {
  fireEvent.click(screen.getByTestId(role === 'lead' ? 'model-picker' : 'helper-picker'))
  const menu = screen.queryByRole('menu', { name: role === 'lead' ? 'Lead models' : 'Helper models' })
  if (menu === null) return false
  fireEvent.click(within(menu).getByText(name === 'None' ? 'No helper' : name))
  return true
}

/**
 * The desktop window, with a paired phone beside it, while the sidecar's replies and events reach it in an order the
 * seed picks. The sidecar takes each call when it comes and saves at once, as the real one does, and only what it sends
 * back is held. Whatever the order:
 * 1. each send runs the roles the pickers showed at its click, but for a role a phone saved that the window had not
 *    heard of yet,
 * 2. once everything landed, the pickers show the roles saved with the highest revision,
 * 3. a role whose last change was a click here ends saved as that click,
 * 4. `studio_flushed` goes out only once every pick and the open draft are saved.
 */
it('keeps the newest roles and runs each send on the roles shown at its click, whatever order the replies land in', async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), steps, async (s, plan) => {
      cleanup()
      resetSidecar()
      window.localStorage.clear()
      const broken: string[] = []
      let racing = false
      /** Desktop picks clicked, and picks whose save the window heard back from. */
      const picks = { clicked: 0, saved: 0 }
      /** Phone saves by role, and those the window has not heard of yet. */
      const phone = { saves: { lead: 0, helper: 0 }, unheard: { lead: 0, helper: 0 } }
      /** The last change to each role, by whom, so 3 knows which to check. */
      const lastChange: Partial<Record<Role, { by: 'desktop'; name: Shown } | { by: 'phone' }>> = {}
      const clicks: { shown: ReturnType<typeof shown>; phoneSaves: Record<Role, number>; unheard: Record<Role, number> }[] = []
      let sendsTaken = 0
      let draftSaved = ''

      const projectOf = () => {
        const found = store.projects.find((p) => p.id === projectA.id)
        if (found === undefined) throw new Error('project A is gone from the mocked sidecar')
        return found
      }
      /** Saves a role change on project A, as the sidecar does: a new revision, then an event to every window. */
      const saveRole = (role: Role, model: ModelChoice | null, heard: () => void = () => {}) => {
        const change = role === 'lead' && model !== null ? { model } : { helper: model }
        store.projects = store.projects.map((p) => (p.id === projectA.id ? { ...p, ...change, roles: p.roles + 1 } : p))
        const saved = projectOf()
        void s.schedule(Promise.resolve(), `event roles ${saved.roles}`).then(() => {
          heard()
          listeners.sidecar.forEach((listener) => listener({ payload: { type: 'project', project: saved } }))
        })
        return saved
      }
      const desktopSave = (role: Role) => (params: Params, real: () => Promise<unknown>) => {
        if (!racing) return real()
        const saved = saveRole(role, params.model as ModelChoice | null)
        return s.schedule(Promise.resolve(saved), `${role} reply roles ${saved.roles}`).then((answer) => {
          picks.saved += 1
          return answer
        })
      }

      const store = mockSidecar(
        {
          'projects.setLead': desktopSave('lead'),
          'projects.setHelper': desktopSave('helper'),
          'drafts.set': (params, real) => {
            if (!racing) return real()
            return s.schedule(real(), 'draft reply').then((answer) => {
              draftSaved = String(params.text)
              return answer
            })
          },
          'state.get': (_, real) => (racing ? s.schedule(real(), 'state reply') : real()),
          'chat.send': (params, real) => {
            if (!racing) return real()
            // The sidecar freezes the turn's roles as it takes the send: the carried ones, and the rest as saved now.
            const pair = (params.pair ?? {}) as SentRoles
            const saved = projectOf()
            const ran = { lead: shownOf(pair.lead ?? saved.model), helper: shownOf(pair.helper === undefined ? saved.helper : pair.helper) }
            const click = clicks[sendsTaken]
            sendsTaken += 1
            for (const role of ['lead', 'helper'] as const) {
              const phoneMeanwhile = phone.saves[role] !== click.phoneSaves[role] || click.unheard[role] > 0
              if (!phoneMeanwhile && ran[role] !== click.shown[role]) broken.push(`send ${sendsTaken} ran ${role} ${ran[role]}, shown ${click.shown[role]}`)
            }
            return s.schedule(real(), 'send reply')
          },
        },
        [projectA, projectB],
      )
      const answer = invokeMock.getMockImplementation()
      invokeMock.mockImplementation((command: string, args: unknown) => {
        if (command === 'studio_flushed') {
          if (picks.saved !== picks.clicked) broken.push(`flushed with ${picks.clicked - picks.saved} of ${picks.clicked} picks unsaved`)
          if (prompt().value !== '' && prompt().value !== draftSaved) broken.push(`flushed with draft "${prompt().value}" unsaved, saved "${draftSaved}"`)
        }
        return answer?.(command, args)
      })

      render(<StudioApp />)
      fireEvent.click(await within(screen.getByRole('navigation', { name: 'Projects' })).findByText('Project A'))
      await waitFor(() => expect(sidecarCalls('chat.open')).toHaveLength(1))
      await waitFor(() => expect(sidecarCalls('setup.check').length).toBeGreaterThan(0))
      await waitFor(() => expect(screen.getByTestId('model-picker').textContent).toBe('Opus 5.5'))
      await pause(0)
      racing = true

      /** Text typed whose save still waits for typing to pause. */
      let typedUnsaved = false
      const run = async (step: Action, index: number) => {
        switch (step.kind) {
          case 'pick':
            if (pick(step.role, step.name)) {
              picks.clicked += 1
              lastChange[step.role] = { by: 'desktop', name: step.name }
            }
            return
          case 'phone': {
            phone.saves[step.role] += 1
            phone.unheard[step.role] += 1
            lastChange[step.role] = { by: 'phone' }
            saveRole(step.role, modelOf(step.name), () => (phone.unheard[step.role] -= 1))
            return
          }
          case 'send': {
            fireEvent.change(prompt(), { target: { value: `message ${index}` } })
            await act(async () => {})
            const send = screen.getByTestId('send') as HTMLButtonElement
            if (send.disabled) {
              typedUnsaved = true
              return
            }
            clicks.push({ shown: shown(), phoneSaves: { ...phone.saves }, unheard: { ...phone.unheard } })
            fireEvent.click(send)
            typedUnsaved = false
            return
          }
          case 'restart':
            await act(async () => {
              listeners.sidecar.forEach((listener) => listener({ payload: { type: 'engine', state: 'restarting' } }))
              listeners.sidecar.forEach((listener) => listener({ payload: { type: 'ready', version: '1.2.3' } }))
            })
            return
          case 'quit':
            fireEvent.change(prompt(), { target: { value: `note ${index}` } })
            typedUnsaved = false
            await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
            return
        }
      }

      // A held reply or event lands, and what it sets off runs and draws before the next step.
      const release = () =>
        act(async () => {
          await s.waitOne()
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
      const letGo = async (count: number) => {
        for (let i = 0; i < count && s.count() > 0; i += 1) await release()
      }
      for (const [index, [step, released]] of plan.entries()) {
        await run(step, index)
        await act(async () => {})
        await letGo(released)
      }
      // Everything still held lands, and so does what it sets off, a draft save typing left waiting included.
      for (let quiet = false; !quiet; ) {
        while (s.count() > 0) await release()
        await pause(typedUnsaved ? 450 : 20)
        typedUnsaved = false
        quiet = s.count() === 0
      }

      const saved = projectOf()
      expect(broken).toEqual([])
      expect(shown()).toEqual({ lead: shownOf(saved.model), helper: shownOf(saved.helper) })
      for (const role of ['lead', 'helper'] as const) {
        const change = lastChange[role]
        if (change?.by === 'desktop') expect(shownOf(role === 'lead' ? saved.model : saved.helper)).toBe(change.name)
      }
      cleanup()
    }),
    { seed: SEED, numRuns: 80 },
  )
}, 240_000)
