// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
const { invokeMock, listeners } = vi.hoisted(() => ({ invokeMock: vi.fn(), listeners: [] as Listener[] }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, listener: Listener) => {
    if (name === 'sidecar://event') listeners.push(listener)
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve() }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }))

import type { Login, Setup, Toolchain } from '../../sidecar/src/protocol'
import type { SlicerCheck } from './api'
import StudioApp from './StudioApp'

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
  listeners.length = 0
})

const signedOut: Login[] = [
  { provider: 'anthropic', name: 'Anthropic', login: null, kinds: ['oauth', 'api_key'] },
  { provider: 'openai-codex', name: 'ChatGPT', login: null, kinds: ['oauth'] },
  { provider: 'opencode-go', name: 'OpenCode Go', login: null, kinds: ['api_key'] },
]
const claudeIn = signedOut.map((login) => (login.provider === 'anthropic' ? { ...login, login: 'api_key' as const } : login))

type Machine = { logins: Login[]; toolchain: Toolchain; slicer: SlicerCheck }
const ready: Machine = { logins: claudeIn, toolchain: { uv: '0.9.2', python: '3.12.1' }, slicer: { found: 'ready', version: '02.08.02.61' } }

type Calls = Record<string, (params: Record<string, unknown>, real: () => Promise<unknown>) => Promise<unknown>>

function mockApp(setup: Setup, machine: Machine, overrides: Calls = {}) {
  const store = { setup, logins: machine.logins }
  const state = () => ({ setup: store.setup, settings: { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, thinking: 'high', printer: {} }, projects: [], drafts: {}, importBlocked: null })
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'state.get': state,
    'setup.set': (params) => {
      store.setup = params as Setup
      return state()
    },
    'setup.tools': () => machine.toolchain,
    'auth.status': () => store.logins,
    'setup.check': () => [],
    'models.list': () => [],
    'projects.status': () => ({}),
    'app.ping': () => ({ version: '1.2.3' }),
  }
  invokeMock.mockImplementation((command: string, args: { method: string; params: Record<string, unknown> }) => {
    if (command === 'studio_slicer') return Promise.resolve(machine.slicer)
    if (command !== 'sidecar') return Promise.resolve(undefined)
    const real = () => Promise.resolve(answers[args.method]?.(args.params) ?? null)
    const override = overrides[args.method]
    return override ? override(args.params, real) : real()
  })
  return store
}

const saved = () => invokeMock.mock.calls.filter(([command, args]) => command === 'sidecar' && args.method === 'setup.set').map(([, args]) => args.params)
const row = (name: string) => within(screen.getByTestId(`check-${name}`))
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const emit = (event: object) => act(async () => listeners.forEach((listener) => listener({ payload: event })))

describe('setup', () => {
  it('opens on Welcome, then Check your Mac, and Continue finishes it at the start screen', async () => {
    mockApp({ step: 'welcome', done: false }, ready)
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start setup' }))
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
    expect(screen.queryByTestId('start-screen')).toBeNull()
    expect(screen.queryByTestId('readiness')).toBeNull()
    fireEvent.click(button('Continue'))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    expect(saved()).toEqual([
      { step: 'check', done: false },
      { step: 'check', done: true },
    ])
  })

  it('reopens on the step it was left at', async () => {
    mockApp({ step: 'check', done: false }, ready)
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start setup' })).toBeNull()
  })

  it('stays out of the way of a person whose setup is done', async () => {
    mockApp({ step: 'welcome', done: true }, ready)
    render(<StudioApp />)
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    expect(screen.queryByTestId('setup')).toBeNull()
  })

  it('shows each row as Checking until its part answers, and Continue waits', async () => {
    mockApp({ step: 'check', done: false }, ready, { 'setup.tools': () => new Promise(() => {}) })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Checking your Mac' })).toBeTruthy()
    expect(await row('claude').findByText('Ready')).toBeTruthy()
    expect(await row('bambu').findByText('Ready')).toBeTruthy()
    expect(row('uv').getByText('Checking')).toBeTruthy()
    expect(row('python').getByText('Checking')).toBeTruthy()
    expect(button('Continue').disabled).toBe(true)
  })

  it('asks for a sign-in when no agent has one, and reads the sign-ins again once one ends', async () => {
    const store = mockApp({ step: 'check', done: false }, { ...ready, logins: signedOut })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Sign in to an agent' })).toBeTruthy()
    expect(row('claude').getByText('Needs login')).toBeTruthy()
    expect(row('chatgpt').getByText('Needs login')).toBeTruthy()
    expect(button('Continue').disabled).toBe(true)
    fireEvent.click(row('chatgpt').getByRole('button', { name: 'Sign in' }))
    expect(invokeMock).toHaveBeenCalledWith('sidecar', { method: 'auth.login', params: { provider: 'openai-codex' } })

    store.logins = signedOut.map((login) => (login.provider === 'openai-codex' ? { ...login, login: 'oauth' as const } : login))
    await emit({ type: 'login', provider: 'openai-codex', step: 'done' })
    expect(await row('chatgpt').findByText('Ready')).toBeTruthy()
    expect(row('claude').getByText('Not signed in. Optional while ChatGPT works.')).toBeTruthy()
    expect(button('Continue').disabled).toBe(false)
  })

  it('names uv as the one thing to install, and Python waits for it', async () => {
    mockApp({ step: 'check', done: false }, { ...ready, toolchain: { uv: null } })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'One thing to install' })).toBeTruthy()
    expect(row('uv').getByText('Missing')).toBeTruthy()
    expect(row('uv').getByRole('button', { name: 'Copy install command' })).toBeTruthy()
    expect(row('python').getByText('Needs uv')).toBeTruthy()
    expect(button('Continue').disabled).toBe(true)
  })

  it('goes on without a slicer when Bambu Studio is not found', async () => {
    mockApp({ step: 'check', done: false }, { ...ready, slicer: { found: 'none' } })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'No slicer found' })).toBeTruthy()
    expect(row('bambu').getByText('Not found')).toBeTruthy()
    fireEvent.click(button('Continue without a slicer'))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    expect(saved()).toEqual([{ step: 'check', done: true }])
  })

  it('lets a check that failed run again', async () => {
    let fails = true
    mockApp({ step: 'check', done: false }, ready, {
      'setup.tools': (_, real) => (fails ? Promise.reject('The engine restarted before it answered.') : real()),
    })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'The check did not finish' })).toBeTruthy()
    expect(row('uv').getByText('Not checked')).toBeTruthy()
    expect(button('Continue').disabled).toBe(true)
    fails = false
    fireEvent.click(button('Check again'))
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
  })

  it('saves one step at a time', async () => {
    let release = () => {}
    mockApp({ step: 'welcome', done: false }, ready, {
      'setup.set': (_, real) => new Promise((resolve) => (release = () => resolve(real()))),
    })
    render(<StudioApp />)
    const start = await screen.findByRole('button', { name: 'Start setup' })
    fireEvent.click(start)
    fireEvent.click(start)
    await act(async () => release())
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
    expect(saved()).toEqual([{ step: 'check', done: false }])
  })

  it('a state read from before setup finished does not open it again', async () => {
    let reads = 0
    let release = () => {}
    mockApp({ step: 'welcome', done: false }, ready, {
      'state.get': (_, real) => {
        if (reads++ > 0) return real()
        const before = real()
        return new Promise((resolve) => (release = () => resolve(before)))
      },
    })
    render(<StudioApp />)
    await emit({ type: 'ready', version: '1.2.3' })
    fireEvent.click(await screen.findByRole('button', { name: 'Start setup' }))
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
    fireEvent.click(button('Continue'))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    await act(async () => release())
    expect(screen.queryByTestId('setup')).toBeNull()
  })
})
