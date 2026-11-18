// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

import type { AppState, ChatView, ModelOption, Printer, Project } from '../../sidecar/src/protocol'
import { load, loadModels, savePrinter, saveSettings, show, useStudio, useStudioEvents } from './store'

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
})

const project: Project = { id: '2026-11-17-clip', conversation: 1, title: 'Clip', createdMs: 0 }
const projects = [project]

function Window() {
  useStudioEvents(projects)
  return null
}

it('drops a chat load that answers after the window opened again', async () => {
  let finishOpen: (view: ChatView) => void = () => {}
  invokeMock.mockImplementation((command: string, { method }: { method?: string } = {}) => {
    if (command === 'sidecar' && method === 'chat.open') return new Promise((resolve) => (finishOpen = resolve))
    if (command === 'sidecar' && method === 'projects.status') return Promise.resolve({})
    return Promise.resolve([])
  })
  const first = render(<Window />)
  act(() => show(project))
  const loading = load()
  first.unmount()
  render(<Window />)

  await act(async () => {
    finishOpen({ project: project.id, entries: [], running: true, waiting: null, turn: null, seq: 2 })
    await loading
  })
  expect(useStudio.getState().view).toBeNull()
})

it('takes saves that answer the app state in the order they were made, so a late answer never puts back an older printer', async () => {
  const p2s: Printer = { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PLA Basic @BBL P2S' }
  const a1: Printer = { machine: 'Bambu Lab A1 mini 0.4 nozzle', process: '0.20mm Standard @BBL A1M', filament: 'Bambu PLA Basic @BBL A1M' }
  const state = (printer: Printer): AppState => ({
    setup: { step: 'ready', done: true },
    settings: { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, thinking: 'high', printer, astra: false },
    projects: [],
    drafts: {},
    importBlocked: null,
  })
  let answerSettings: (value: AppState) => void = () => {}
  const methods: string[] = []
  invokeMock.mockImplementation((command: string, { method }: { method?: string } = {}) => {
    if (command === 'sidecar' && method !== undefined) methods.push(method)
    if (command === 'sidecar' && method === 'settings.set') return new Promise((resolve) => (answerSettings = resolve))
    if (command === 'sidecar' && method === 'printer.set') return Promise.resolve(state(a1))
    if (command === 'sidecar' && method === 'projects.status') return Promise.resolve({})
    return Promise.resolve([])
  })
  render(<Window />)

  const settings = saveSettings({ astra: false })
  const printer = savePrinter({ ...a1, plate: 'Textured PEI Plate' })
  await act(async () => {})
  expect(methods).not.toContain('printer.set')
  await act(async () => {
    answerSettings(state(p2s))
    await Promise.all([settings, printer])
  })
  expect(useStudio.getState().settings?.printer).toEqual(a1)
})

it('keeps the newest model list when an older read answers late', async () => {
  const opus: ModelOption = { provider: 'anthropic', modelId: 'claude-opus-5-5', name: 'Opus 5.5', description: '' }
  const answers: ((models: ModelOption[]) => void)[] = []
  invokeMock.mockImplementation((command: string, { method }: { method?: string } = {}) => {
    if (command === 'sidecar' && method === 'models.list') return new Promise((resolve) => answers.push(resolve))
    if (command === 'sidecar' && method === 'projects.status') return Promise.resolve({})
    return Promise.resolve([])
  })
  render(<Window />)
  const reads = answers.length
  act(() => loadModels())
  act(() => loadModels())
  const [older, newer] = answers.slice(reads)

  await act(async () => newer([opus]))
  await act(async () => older([]))
  expect(useStudio.getState().models).toEqual([opus])
})
