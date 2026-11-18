// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
const { invokeMock, listeners } = vi.hoisted(() => ({ invokeMock: vi.fn(), listeners: [] as Listener[] }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_: string, listener: Listener) => {
    listeners.push(listener)
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve() }))

import { type Clock, createDrafts } from './drafts'
import { useStudio, useStudioEvents } from './store'

const clock: Clock = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
}

/**
 * Opens the window's store on a mocked sidecar. `drafts.set` answers what `save` gives, and each save's text is kept.
 */
function open(save: () => Promise<{ rev: number }>) {
  const saved: string[] = []
  invokeMock.mockImplementation((command: string, { method, params }: { method?: string; params?: { text?: string } } = {}) => {
    if (command !== 'sidecar') return Promise.resolve(undefined)
    if (method === 'drafts.set') {
      saved.push(params?.text ?? '')
      return save()
    }
    if (method === 'projects.status') return Promise.resolve({})
    return Promise.resolve([])
  })
  render(<Window />)
  return saved
}

function Window() {
  useStudioEvents([])
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  invokeMock.mockReset()
  listeners.length = 0
})

it('saves the open screen once typing pauses, and each key press starts the pause again', async () => {
  const saved = open(() => Promise.resolve({ rev: 1 }))
  const drafts = createDrafts(clock, () => {})

  drafts.type('A cable')
  await vi.advanceTimersByTimeAsync(399)
  drafts.type('A cable clip')
  await vi.advanceTimersByTimeAsync(399)
  expect(saved).toEqual([])

  await vi.advanceTimersByTimeAsync(1)
  expect(saved).toEqual(['A cable clip'])
  expect(drafts.state.getState().shown.text).toBe('A cable clip')
})

it('saves a draft the engine refused at quit again as soon as the engine is back', async () => {
  let refuse = true
  const saved = open(() => (refuse ? Promise.reject(new Error('The engine is restarting')) : Promise.resolve({ rev: 1 })))
  const drafts = createDrafts(clock, () => {})
  drafts.type('A cable clip')

  let quit = false
  const quitting = drafts.quit().then(() => (quit = true))
  await vi.advanceTimersByTimeAsync(0)
  expect(saved).toEqual(['A cable clip'])
  expect(quit).toBe(false)

  refuse = false
  await act(async () => listeners.forEach((listener) => listener({ payload: { type: 'ready', version: '0.3.2' } })))
  await quitting
  expect(saved).toEqual(['A cable clip', 'A cable clip'])
  expect(quit).toBe(true)
})

it('tries a refused save again each pause, and calls the quit off when the last try fails', async () => {
  const saved = open(() => Promise.reject(new Error('The engine is restarting')))
  const drafts = createDrafts(clock, () => {})
  drafts.type('A cable clip')

  const quitting = drafts.quit().catch((err: unknown) => err)
  await vi.advanceTimersByTimeAsync(2999)
  expect(saved).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(saved).toHaveLength(2)

  await vi.advanceTimersByTimeAsync(2 * 3000)
  expect(saved).toHaveLength(4)
  expect(await quitting).toEqual(new Error('a draft could not be saved'))
  expect(useStudio.getState().error).toBe('A draft could not be saved, so Materialize 3D stayed open. Quit again once the engine is back.')
})
