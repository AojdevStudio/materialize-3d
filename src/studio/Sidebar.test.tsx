// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
type Call = { method: string; params: Record<string, unknown> }
const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn<(command: string, call: Call) => Promise<unknown>>(),
  listeners: [] as Listener[],
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, listener: Listener) => {
    listeners.push(listener)
    return Promise.resolve(() => {})
  },
}))

import type { Project, ProjectStatus } from '../../sidecar/src/protocol'
import Sidebar from './Sidebar'
import { useStudio, useStudioEvents } from './store'

// jsdom has no layout, so the open row menu's scroll into view is a no-op here.
Element.prototype.scrollIntoView = vi.fn()

const bracket: Project = { id: '2026-11-10-bracket', conversation: 1, title: 'Bracket', createdMs: 1_000, model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, helper: null, roles: 0 }
const knob: Project = { id: '2026-11-11-knob', conversation: 2, title: 'Knob', createdMs: 2_000, model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, helper: null, roles: 0 }
const clip: Project = { id: '2026-11-12-clip', conversation: 3, title: 'Clip', createdMs: 3_000, model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, helper: null, roles: 0 }
const projects = [bracket, knob, clip]

let read: Record<string, ProjectStatus>

beforeEach(() => {
  read = {
    [bracket.id]: { running: false, printed: false, printFiles: 1, lastMs: 5_000 },
    [knob.id]: { running: false, printed: false, printFiles: 0, lastMs: 4_000 },
    [clip.id]: { running: false, printed: true, printFiles: 2, lastMs: 6_000 },
  }
  invokeMock.mockImplementation((_command, { method, params }) => {
    if (method === 'projects.status') return Promise.resolve(structuredClone(read))
    if (method === 'projects.markPrinted') {
      const id = String(params.project)
      read = { ...read, [id]: { ...read[id]!, printed: true } }
      return Promise.resolve(null)
    }
    return Promise.reject(new Error(`no ${method} here`))
  })
})

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
  listeners.length = 0
})

/** The sidebar in a window that feeds the store, as StudioApp does. */
function Window() {
  useStudioEvents(projects)
  return <Sidebar projects={projects} current={null} engine="Opus 5.5" printer={null} onOpen={() => {}} onNew={() => {}} onSettings={() => {}} />
}

function show() {
  render(<Window />)
}

const emit = (event: object) => act(() => listeners.forEach((listener) => listener({ payload: event })))
const chat = (project: Project, running: boolean, seq: number) =>
  emit({ type: 'chat', project: project.id, entries: [], running, waiting: null, turn: null, handoffs: [], seq })
const statusReads = () => invokeMock.mock.calls.filter(([, call]) => call.method === 'projects.status').length
const groupOf = (project: Project) => screen.getByTestId(`project-${project.id}`).closest('section')?.getAttribute('data-testid')
const groups = () => Object.fromEntries(projects.map((p) => [p.title, groupOf(p)]))
const lastStatus = () => useStudio.getState().status
const shownError = () => useStudio.getState().error

describe('Sidebar', () => {
  it('reads the status once and groups each project by it', async () => {
    show()
    await waitFor(() => expect(groups()).toEqual({ Bracket: 'group-ready', Knob: 'group-drafts', Clip: 'group-printed' }))
    expect(statusReads()).toBe(1)
    await waitFor(() => expect(lastStatus()).toEqual(read))
  })

  it('moves a row on a newer chat state, ignores a stale seq, and reads again only when running changes', async () => {
    show()
    await waitFor(() => expect(groupOf(knob)).toBe('group-drafts'))

    await chat(knob, true, 2)
    expect(groupOf(knob)).toBe('group-working')
    await waitFor(() => expect(statusReads()).toBe(2))
    await waitFor(() => expect(lastStatus()?.[knob.id]).toEqual({ ...read[knob.id], running: true }))

    await chat(knob, false, 2)
    expect(groupOf(knob)).toBe('group-working')
    await chat(knob, false, 1)
    expect(groupOf(knob)).toBe('group-working')
    await chat(knob, true, 3)
    expect(groupOf(knob)).toBe('group-working')
    await act(async () => {})
    expect(statusReads()).toBe(2)

    await chat(knob, false, 4)
    expect(groupOf(knob)).toBe('group-drafts')
    await waitFor(() => expect(statusReads()).toBe(3))
    await waitFor(() => expect(lastStatus()?.[knob.id]?.running).toBe(false))
  })

  it('drops the chat states of an engine that started again and reads the status anew', async () => {
    show()
    await waitFor(() => expect(statusReads()).toBe(1))
    await chat(knob, true, 2)
    await waitFor(() => expect(statusReads()).toBe(2))

    await emit({ type: 'ready', version: '9.9.9' })
    await waitFor(() => expect(groupOf(knob)).toBe('group-drafts'))
    expect(statusReads()).toBe(3)
    await chat(knob, true, 1)
    expect(groupOf(knob)).toBe('group-working')
  })

  it('marks a project printed from its row menu, then reads the status again', async () => {
    show()
    await waitFor(() => expect(groupOf(bracket)).toBe('group-ready'))
    expect(screen.queryByRole('button', { name: 'Clip menu' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Bracket menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mark as printed' }))
    expect(screen.queryByRole('menu')).toBeNull()
    await waitFor(() => expect(groupOf(bracket)).toBe('group-printed'))
    expect(invokeMock.mock.calls.map(([, call]) => call)).toEqual([
      { method: 'projects.status', params: {} },
      { method: 'projects.markPrinted', params: { project: bracket.id } },
      { method: 'projects.status', params: {} },
    ])
    await waitFor(() => expect(lastStatus()?.[bracket.id]?.printed).toBe(true))
    expect(shownError()).toBeNull()
  })

  it('shows a failed read in the error bar', async () => {
    invokeMock.mockImplementation(() => Promise.reject('the engine restarted'))
    show()
    await waitFor(() => expect(shownError()).toBe('the engine restarted'))
    expect(groups()).toEqual({ Bracket: 'group-drafts', Knob: 'group-drafts', Clip: 'group-drafts' })
  })
})
