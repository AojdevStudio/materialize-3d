// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

import type { ChatView, Project } from '../../sidecar/src/protocol'
import { load, show, useStudio, useStudioEvents } from './store'

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
