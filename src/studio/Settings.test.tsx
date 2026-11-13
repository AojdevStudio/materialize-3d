// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
const { invokeMock, revealMock, listeners } = vi.hoisted(() => ({ invokeMock: vi.fn(), revealMock: vi.fn(), listeners: [] as Listener[] }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, listener: Listener) => {
    if (name === 'sidecar://event') listeners.push(listener)
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve(), revealItemInDir: revealMock }))
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }))

import type { Login, ModelChoice, ModelOption, Printer, Project, Settings, Toolchain } from '../../sidecar/src/protocol'
import type { BambuLastUsed, PrinterChoice, SlicerCheck } from './api'
import StudioApp from './StudioApp'

Element.prototype.scrollIntoView = vi.fn()

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
  revealMock.mockReset()
  listeners.length = 0
  slicerAnswer = undefined
})

const emit = (event: object) => act(async () => listeners.forEach((listener) => listener({ payload: event })))

const claudeOnly: Login[] = [
  { provider: 'anthropic', name: 'Anthropic', login: 'oauth', kinds: ['oauth', 'api_key'] },
  { provider: 'openai-codex', name: 'ChatGPT', login: null, kinds: ['oauth'] },
]
const bothIn = claudeOnly.map((login) => (login.provider === 'openai-codex' ? { ...login, login: 'oauth' as const } : login))
const models: ModelOption[] = [
  { provider: 'anthropic', modelId: 'claude-opus-5-5', name: 'Opus 5.5', description: 'The strongest for hard parts.' },
  { provider: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Fast for everyday parts.' },
]
const FOLDER = '/Users/someone/Documents/Materialize 3D'
const project: Project = { id: '2026-11-12-clip', conversation: 1, title: 'Cable clip', createdMs: 1 }

const A1_MINI = { machine: 'Bambu Lab A1 mini 0.4 nozzle', process: '0.20mm Standard @BBL A1M', filament: 'Bambu PLA Basic @BBL A1M' }
const printers: PrinterChoice[] = [
  {
    printer: 'Bambu Lab A1 mini',
    plates: ['Textured PEI Plate'],
    defaultPlate: 'Textured PEI Plate',
    nozzles: [{ nozzle: '0.4', ...A1_MINI, processes: [A1_MINI.process], filaments: [A1_MINI.filament] }],
  },
]
const preset = (name: string) => ({ name, system: name })
const lastUsedA1Mini: BambuLastUsed = {
  printer: 'Bambu Lab A1 mini',
  nozzle: '0.4',
  machine: preset(A1_MINI.machine),
  process: preset(A1_MINI.process),
  filament: preset(A1_MINI.filament),
  plate: 'Textured PEI Plate',
}

type Machine = { toolchain: Toolchain; slicer: SlicerCheck }
const ready: Machine = { toolchain: { uv: '0.9.2', python: '3.12.1' }, slicer: { found: 'ready', version: '02.08.02.61' } }

/** When set, each slicer check waits for this answer instead of the machine's. */
let slicerAnswer: (() => Promise<SlicerCheck>) | undefined

function mockApp(machine: Machine = ready, logins: Login[] = claudeOnly, waiting: object | null = null) {
  revealMock.mockResolvedValue(undefined)
  const store: { settings: Settings; logins: Login[] } = {
    logins,
    settings: {
      model: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
      thinking: 'high',
      printer: { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PETG Basic @BBL P2S', plate: 'Textured PEI Plate' },
      astra: true,
    },
  }
  const state = () => ({ setup: { step: 'check', done: true }, settings: store.settings, projects: [project], drafts: {}, importBlocked: null })
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'state.get': state,
    'settings.set': (params) => {
      store.settings = { ...store.settings, ...params }
      return state()
    },
    'printer.set': (params) => {
      store.settings = { ...store.settings, printer: params as Printer }
      return state()
    },
    'setup.tools': () => machine.toolchain,
    'auth.status': () => store.logins,
    'setup.check': () => [],
    'models.list': () => models,
    'projects.status': () => ({}),
    'app.ping': () => ({ version: '1.2.3' }),
    'chat.open': () => ({ project: project.id, entries: [], running: false, waiting, turn: null, seq: 0 }),
  }
  invokeMock.mockImplementation((command: string, args: { method: string; params: Record<string, unknown> }) => {
    if (command === 'studio_slicer') return slicerAnswer?.() ?? Promise.resolve(machine.slicer)
    if (command === 'studio_projects_folder') return Promise.resolve(FOLDER)
    if (command === 'studio_printers') return Promise.resolve(printers)
    if (command === 'bambu_last_used') return Promise.resolve(lastUsedA1Mini)
    if (command === 'studio_files') return Promise.resolve([])
    if (command !== 'sidecar') return Promise.resolve(undefined)
    return Promise.resolve(answers[args.method]?.(args.params) ?? null)
  })
  return store
}

const saves = () => invokeMock.mock.calls.filter(([command, args]) => command === 'sidecar' && args.method === 'settings.set').map(([, args]) => args.params)
const button = (name: string) => screen.getByRole('button', { name })
const section = (name: string) => screen.getByRole('region', { name })

async function openSettings() {
  fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
  return screen.findByTestId('settings')
}

async function show(name: string) {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('button', { name }))
  return section(name)
}

describe('settings', () => {
  it('opens from the gear on the four sections, without Agent tools', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    const nav = within(screen.getByRole('navigation', { name: 'Settings' }))
    expect(nav.getAllByRole('button').map((item) => item.textContent)).toEqual(['Agents and models', 'Slicer and printer', 'Build tools', 'Projects folder'])
    expect(nav.getByRole('button', { name: 'Agents and models' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText(/Agent tools/)).toBeNull()
    expect(screen.queryByTestId('start-screen')).toBeNull()
  })

  it('shows each sign-in, and a missing one is fixed in setup, which Back leaves for Settings', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    const claude = within(await screen.findByTestId('settings-claude'))
    expect(await claude.findByText('Ready')).toBeTruthy()
    expect(claude.queryByRole('button')).toBeNull()
    const chatgpt = within(screen.getByTestId('settings-chatgpt'))
    expect(await chatgpt.findByText('Needs login')).toBeTruthy()
    fireEvent.click(chatgpt.getByRole('button', { name: 'Fix in setup' }))
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
    fireEvent.click(button('Back'))
    expect(await screen.findByTestId('settings')).toBeTruthy()
  })

  it('saves the default model through settings.set, and new projects start with it', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    const opus = (await screen.findByRole('radio', { name: /Opus 5.5/ })) as HTMLInputElement
    await waitFor(() => expect(opus.checked).toBe(true))
    fireEvent.click(screen.getByRole('radio', { name: /Sonnet 5.5/ }))
    await waitFor(() => expect(saves()).toEqual([{ model: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' } satisfies ModelChoice }]))
    await waitFor(() => expect((screen.getByRole('radio', { name: /Sonnet 5.5/ }) as HTMLInputElement).checked).toBe(true))
    fireEvent.click(button('Close'))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Sonnet 5.5/ })).toBeTruthy()
  })

  it('turns Astra off through settings.set when ChatGPT is signed in', async () => {
    mockApp(ready, bothIn)
    render(<StudioApp />)
    await openSettings()
    const astra = (await screen.findByRole('switch', { name: /Astra/ })) as HTMLInputElement
    await waitFor(() => expect(astra.disabled).toBe(false))
    expect(astra.checked).toBe(true)
    fireEvent.click(astra)
    await waitFor(() => expect(saves()).toEqual([{ astra: false }]))
    await waitFor(() => expect(astra.checked).toBe(false))
  })

  it('shows Astra off and locked without a ChatGPT sign-in', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    expect(await screen.findByText('Needs a ChatGPT sign-in.')).toBeTruthy()
    const astra = screen.getByRole('switch', { name: /Astra/ }) as HTMLInputElement
    expect(astra.checked).toBe(false)
    expect(astra.disabled).toBe(true)
  })

  it('reads the sign-ins again when one ends while Settings shows', async () => {
    const store = mockApp()
    render(<StudioApp />)
    await openSettings()
    const chatgpt = within(await screen.findByTestId('settings-chatgpt'))
    expect(await chatgpt.findByText('Needs login')).toBeTruthy()
    store.logins = bothIn
    await emit({ type: 'login', provider: 'openai-codex', step: 'done' })
    expect(await chatgpt.findByText('Ready')).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('switch', { name: /Astra/ }) as HTMLInputElement).disabled).toBe(false))
  })

  it('shows a running sign-in\'s question over Settings', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    await emit({ type: 'login', provider: 'openai-codex', step: 'ask', kind: 'text', message: 'Paste the code from the browser' })
    expect(await within(screen.getByTestId('settings')).findByTestId('sign-in')).toBeTruthy()
  })

  it('shows a sign-in a waiting turn was refused with as needing login', async () => {
    mockApp(ready, claudeOnly, { kind: 'login', provider: 'anthropic', name: 'Anthropic', fix: 'Sign in to Anthropic. The message picks up where it stopped.' })
    render(<StudioApp />)
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Projects' })).findByText('Cable clip'))
    expect(await screen.findByTestId('setup-needed')).toBeTruthy()
    await openSettings()
    const claude = within(await screen.findByTestId('settings-claude'))
    expect(await claude.findByText('Needs login')).toBeTruthy()
    expect(claude.getByRole('button', { name: 'Fix in setup' })).toBeTruthy()
  })

  it('shows Bambu Studio and the chosen printer, and Change opens setup, which Back leaves for Slicer and printer', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    const slicer = await show('Slicer and printer')
    expect(await within(slicer).findByText('Version 02.08.02.61.')).toBeTruthy()
    const printer = within(await within(slicer).findByTestId('settings-printer'))
    expect(await printer.findByText('Bambu Lab P2S 0.4 nozzle')).toBeTruthy()
    expect(printer.getByText('Bambu PETG Basic @BBL P2S, 0.20mm Standard @BBL P2S, Textured PEI Plate')).toBeTruthy()
    fireEvent.click(printer.getByRole('button', { name: 'Change' }))
    expect(await screen.findByRole('heading', { name: 'Is this your printer?' })).toBeTruthy()
    fireEvent.click(within(screen.getByTestId('setup')).getAllByRole('button', { name: 'Back' })[0])
    expect(await screen.findByRole('region', { name: 'Slicer and printer' })).toBeTruthy()
  })

  it('a slicer check the printer step left by Back does not close the setup step opened after it', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    const slicer = await show('Slicer and printer')
    await within(slicer).findByText('Version 02.08.02.61.')
    let answer = (_: SlicerCheck) => {}
    slicerAnswer = () => new Promise((resolve) => (answer = resolve))
    fireEvent.click(within(await within(slicer).findByTestId('settings-printer')).getByRole('button', { name: 'Change' }))
    await screen.findByRole('region', { name: 'Your printer' })
    const late = answer
    fireEvent.click(within(screen.getByTestId('setup')).getAllByRole('button', { name: 'Back' })[0])
    fireEvent.click(await within(await show('Agents and models')).findByRole('button', { name: 'Fix in setup' }))
    await screen.findByRole('region', { name: 'Check your Mac' })
    await act(async () => late({ found: 'none' }))
    expect(screen.getByRole('region', { name: 'Check your Mac' })).toBeTruthy()
  })

  it('saves a new printer through setup\'s printer step, and Settings and the sidebar show it', async () => {
    const store = mockApp()
    render(<StudioApp />)
    expect(await screen.findByTestId('printer')).toBeTruthy()
    await openSettings()
    const slicer = await show('Slicer and printer')
    fireEvent.click(within(await within(slicer).findByTestId('settings-printer')).getByRole('button', { name: 'Change' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Looks right' }))
    const row = within(await screen.findByTestId('settings-printer'))
    expect(await row.findByText(A1_MINI.machine)).toBeTruthy()
    expect(store.settings.printer.machine).toBe(A1_MINI.machine)
    fireEvent.click(button('Close'))
    expect((await screen.findByTestId('printer')).getAttribute('title')).toBe(A1_MINI.machine)
  })

  it('shows a missing slicer with its fix in setup', async () => {
    mockApp({ ...ready, slicer: { found: 'none' } })
    render(<StudioApp />)
    await openSettings()
    const bambu = within(await within(await show('Slicer and printer')).findByTestId('settings-bambu'))
    expect(await bambu.findByText('Not found')).toBeTruthy()
    expect(bambu.getByRole('button', { name: 'Fix in setup' })).toBeTruthy()
  })

  it('shows uv and Python with their state', async () => {
    mockApp({ ...ready, toolchain: { uv: '0.9.2', python: null } })
    render(<StudioApp />)
    await openSettings()
    const tools = await show('Build tools')
    expect(await within(within(tools).getByTestId('settings-uv')).findByText('Ready')).toBeTruthy()
    const python = within(within(tools).getByTestId('settings-python'))
    expect(python.getByText('Missing')).toBeTruthy()
    expect(python.getByRole('button', { name: 'Fix in setup' })).toBeTruthy()
  })

  it('shows where projects live, and Reveal shows that folder', async () => {
    mockApp()
    render(<StudioApp />)
    await openSettings()
    const folder = await show('Projects folder')
    expect(await within(folder).findByText(FOLDER)).toBeTruthy()
    fireEvent.click(within(folder).getByRole('button', { name: 'Reveal' }))
    expect(revealMock).toHaveBeenCalledWith(FOLDER)
  })

  it('Close returns to the project it was opened from', async () => {
    mockApp()
    render(<StudioApp />)
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Projects' })).findByText('Cable clip'))
    expect(await screen.findByPlaceholderText('Reply, paste a link, or attach a file')).toBeTruthy()
    await openSettings()
    fireEvent.click(button('Close'))
    expect(await screen.findByPlaceholderText('Reply, paste a link, or attach a file')).toBeTruthy()
    expect(screen.queryByTestId('settings')).toBeNull()
  })
})
