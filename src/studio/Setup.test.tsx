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

import { OFFERED } from '../../sidecar/src/offered'
import type { Login, Printer, Settings, Setup, Toolchain } from '../../sidecar/src/protocol'
import type { BambuLastUsed, PrinterChoice, SlicerCheck } from './api'
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
const signIn = (logins: Login[], provider: Login['provider']) => logins.map((login) => (login.provider === provider ? { ...login, login: 'oauth' as const } : login))
const claudeIn = signedOut.map((login) => (login.provider === 'anthropic' ? { ...login, login: 'api_key' as const } : login))
const bothIn = signIn(claudeIn, 'openai-codex')
const opus = { provider: 'anthropic', modelId: 'claude-opus-5-5' }

const P2S: Printer = { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PETG Basic @BBL P2S 0.4 nozzle' }
const printers: PrinterChoice[] = [
  {
    printer: 'Bambu Lab A1 mini',
    plates: ['Engineering Plate', 'Textured PEI Plate', 'Supertack Plate'],
    defaultPlate: 'Textured PEI Plate',
    nozzles: [
      {
        nozzle: '0.4',
        machine: 'Bambu Lab A1 mini 0.4 nozzle',
        processes: ['0.12mm Fine @BBL A1M', '0.20mm Standard @BBL A1M'],
        process: '0.20mm Standard @BBL A1M',
        filaments: ['Bambu PETG Basic @BBL A1M', 'Bambu PLA Basic @BBL A1M'],
        filament: 'Bambu PLA Basic @BBL A1M',
      },
    ],
  },
  {
    printer: 'Bambu Lab P2S',
    plates: ['Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Supertack Plate'],
    defaultPlate: 'Textured PEI Plate',
    nozzles: [
      {
        nozzle: '0.4',
        machine: P2S.machine,
        processes: ['0.16mm Standard @BBL P2S', P2S.process],
        process: P2S.process,
        filaments: [P2S.filament, 'Bambu PLA Basic @BBL P2S'],
        filament: 'Bambu PLA Basic @BBL P2S',
      },
      {
        nozzle: '0.6',
        machine: 'Bambu Lab P2S 0.6 nozzle',
        processes: ['0.30mm Standard @BBL P2S 0.6 nozzle'],
        process: '0.30mm Standard @BBL P2S 0.6 nozzle',
        filaments: ['Bambu PLA Basic @BBL P2S'],
        filament: 'Bambu PLA Basic @BBL P2S',
      },
    ],
  },
]
const preset = (name: string) => ({ name, system: name })
const lastUsedP2S: BambuLastUsed = {
  printer: 'Bambu Lab P2S',
  nozzle: '0.4',
  machine: preset(P2S.machine),
  process: preset(P2S.process),
  filament: preset(P2S.filament),
  plate: 'Supertack Plate',
}

type Machine = { logins: Login[]; toolchain: Toolchain; slicer: SlicerCheck; lastUsed: BambuLastUsed | null }
const ready: Machine = { logins: claudeIn, toolchain: { uv: '0.9.2', python: '3.12.1' }, slicer: { found: 'ready', version: '02.08.02.61' }, lastUsed: lastUsedP2S }

type Calls = Record<string, (params: Record<string, unknown>, real: () => Promise<unknown>) => Promise<unknown>>

function mockApp(setup: Setup, machine: Machine, overrides: Calls = {}) {
  const settings = { model: opus, thinking: 'high', printer: P2S, astra: true } satisfies Settings
  const store = { setup, logins: machine.logins, settings }
  const state = () => ({ setup: store.setup, settings: store.settings, projects: [], drafts: {}, importBlocked: null })
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'state.get': state,
    'setup.set': (params) => {
      store.setup = params as Setup
      return state()
    },
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
    'models.list': () => OFFERED.filter((model) => store.logins.some((login) => login.provider === model.provider && login.login !== null)),
    'projects.status': () => ({}),
    'app.ping': () => ({ version: '1.2.3' }),
  }
  invokeMock.mockImplementation((command: string, args: { method: string; params: Record<string, unknown> }) => {
    if (command === 'studio_slicer') return Promise.resolve(machine.slicer)
    if (command === 'studio_printers') return Promise.resolve(printers)
    if (command === 'bambu_last_used') return Promise.resolve(machine.lastUsed)
    if (command !== 'sidecar') return Promise.resolve(undefined)
    const real = () => Promise.resolve(answers[args.method]?.(args.params) ?? null)
    const override = overrides[args.method]
    return override ? override(args.params, real) : real()
  })
  return store
}

const calls = (method: string) => invokeMock.mock.calls.filter(([command, args]) => command === 'sidecar' && args.method === method).map(([, args]) => args.params)
const saved = () => calls('setup.set')
const row = (name: string) => within(screen.getByTestId(`check-${name}`))
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
const astra = () => screen.getByRole('switch', { name: 'Let the main agent ask GPT (Astra) for drawings' }) as HTMLInputElement
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) }) as HTMLInputElement
const radios = () => screen.getAllByRole('radio').map((input) => input.closest('label')?.querySelector('.setup-name')?.textContent)
const summary = (name: string) => screen.getByTestId(`ready-${name}`).querySelector('dd')?.textContent
const emit = (event: object) => act(async () => listeners.forEach((listener) => listener({ payload: event })))

describe('setup', () => {
  it('goes Welcome, Check your Mac, Pick a model, Your printer, Ready, and Start a project opens the start screen', async () => {
    mockApp({ step: 'welcome', done: false }, ready)
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start setup' }))
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
    expect(screen.queryByTestId('start-screen')).toBeNull()
    expect(screen.queryByTestId('setup-needed')).toBeNull()
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe('1 Check your Mac')
    fireEvent.click(button('Continue'))
    expect(await screen.findByRole('heading', { name: 'Pick your default model' })).toBeTruthy()
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe('2 Pick a model')
    await screen.findByRole('radio', { name: /^Opus 5.5/ })
    fireEvent.click(button('Continue'))
    expect(await screen.findByRole('heading', { name: 'Is this your printer?' })).toBeTruthy()
    expect(screen.getByRole('listitem', { current: 'step' }).textContent).toBe('3 Your printer')
    fireEvent.click(button('Looks right'))
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeTruthy()
    expect(screen.queryByRole('listitem', { current: 'step' })).toBeNull()
    fireEvent.click(button('Start a project'))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    expect(saved()).toEqual([
      { step: 'check', done: false },
      { step: 'model', done: false },
      { step: 'printer', done: false },
      { step: 'ready', done: false },
      { step: 'ready', done: true },
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
    expect(await screen.findByRole('heading', { name: 'Pick your default model' })).toBeTruthy()
    await screen.findByRole('radio', { name: /^Opus 5.5/ })
    fireEvent.click(button('Continue'))
    fireEvent.click(await screen.findByRole('button', { name: 'Start a project' }))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    expect(saved()).toEqual([
      { step: 'model', done: false },
      { step: 'printer', done: false },
      { step: 'ready', done: false },
      { step: 'ready', done: true },
    ])
    expect(calls('printer.set')).toEqual([])
    expect(screen.queryByTestId('setup-needed')).toBeNull()
  })

  it('names a Bambu Studio that is installed but cannot slice as not usable, not as missing', async () => {
    mockApp({ step: 'check', done: false }, { ...ready, slicer: { found: 'other', detail: 'Bambu Studio 02.07.00.00 is installed. The app needs 02.08.02.61.' } })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Bambu Studio cannot slice' })).toBeTruthy()
    expect(row('bambu').getByText('Not usable')).toBeTruthy()
    expect(row('bambu').getByText('Bambu Studio 02.07.00.00 is installed. The app needs 02.08.02.61.')).toBeTruthy()
    expect(screen.getByText(/won’t get print-ready 3MF files until Bambu Studio can slice\./)).toBeTruthy()
    expect(button('Continue without a slicer')).toBeTruthy()
  })

  it('keeps Send off until the saved setup is known to be done, though the send check already passed', async () => {
    let release = () => {}
    mockApp({ step: 'welcome', done: false }, ready, {
      'state.get': (_, real) => new Promise((resolve) => (release = () => resolve(real()))),
    })
    render(<StudioApp />)
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'A clip' } })
    await act(async () => {})
    expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('send'))
    await act(async () => release())
    expect(await screen.findByRole('button', { name: 'Start setup' })).toBeTruthy()
    expect(invokeMock.mock.calls.some(([command, args]) => command === 'sidecar' && args.method === 'chat.send')).toBe(false)
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
    await screen.findByRole('radio', { name: /^Opus 5.5/ })
    fireEvent.click(button('Continue'))
    fireEvent.click(await screen.findByRole('button', { name: 'Looks right' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start a project' }))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    await act(async () => release())
    expect(screen.queryByTestId('setup')).toBeNull()
  })
})

describe('setup: pick a model', () => {
  it('offers the signed-in agents’ models by short name and line, with Astra off and disabled without ChatGPT', async () => {
    mockApp({ step: 'model', done: false }, ready)
    render(<StudioApp />)
    expect(await screen.findByRole('radio', { name: /^Opus 5.5/ })).toBeTruthy()
    expect(radios()).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Fable 5.2'])
    expect(screen.getByRole('group', { name: 'Claude' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'ChatGPT' })).toBeNull()
    expect(screen.getByText('Best for design and checks. Recommended.')).toBeTruthy()
    expect(radio('Opus 5.5').checked).toBe(true)
    expect(astra().checked).toBe(false)
    expect(astra().disabled).toBe(true)
    fireEvent.click(button('Continue'))
    expect(await screen.findByRole('heading', { name: 'Is this your printer?' })).toBeTruthy()
    expect(calls('settings.set')).toEqual([{ model: opus, astra: false }])
  })

  it('saves the pick as the default new projects take, and Astra as the person left it', async () => {
    mockApp({ step: 'model', done: false }, { ...ready, logins: bothIn })
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('radio', { name: /^Sonnet 5.5/ }))
    expect(screen.getByRole('group', { name: 'ChatGPT' })).toBeTruthy()
    expect(astra().checked).toBe(true)
    fireEvent.click(astra())
    fireEvent.click(button('Continue'))
    fireEvent.click(await screen.findByRole('button', { name: 'Looks right' }))
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeTruthy()
    expect(calls('settings.set')).toEqual([{ model: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }, astra: false }])
    expect(await screen.findByText('Claude, Sonnet 5.5.')).toBeTruthy()
    fireEvent.click(button('Start a project'))
    expect(await screen.findByTestId('start-screen')).toBeTruthy()
    expect(screen.getByTestId('model-picker').textContent).toBe('Sonnet 5.5')
  })

  it('picks a ChatGPT model for a person signed in only to ChatGPT', async () => {
    mockApp({ step: 'model', done: false }, { ...ready, logins: signIn(signedOut, 'openai-codex') })
    render(<StudioApp />)
    expect((await screen.findByRole('radio', { name: /^GPT 6.1 Sol/ }) as HTMLInputElement).checked).toBe(true)
    expect(radios()).toEqual(['GPT 6.1 Sol'])
    fireEvent.click(button('Continue'))
    fireEvent.click(await screen.findByRole('button', { name: 'Looks right' }))
    expect(await screen.findByText('ChatGPT, GPT 6.1 Sol. Astra helps with drawings.')).toBeTruthy()
    expect(calls('settings.set')).toEqual([{ model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }, astra: true }])
  })

  it('keeps Back and the choices off while Continue saves, so a slow save cannot undo Back', async () => {
    let releaseSettings = () => {}
    let releaseStep = () => {}
    mockApp({ step: 'model', done: false }, ready, {
      'settings.set': (_, real) => new Promise((resolve) => (releaseSettings = () => resolve(real()))),
      'setup.set': (_, real) => new Promise((resolve) => (releaseStep = () => resolve(real()))),
    })
    render(<StudioApp />)
    await screen.findByRole('radio', { name: /^Opus 5.5/ })
    const locked = () => button('Back').disabled && radio('Sonnet 5.5').matches(':disabled')
    fireEvent.click(button('Continue'))
    expect(locked()).toBe(true)
    await act(async () => releaseSettings())
    expect(locked()).toBe(true)
    await act(async () => releaseStep())
    expect(await screen.findByRole('heading', { name: 'Is this your printer?' })).toBeTruthy()
    expect(saved()).toEqual([{ step: 'printer', done: false }])
  })

  it('keeps Continue and the choices off while Back saves, so a slow Back cannot be undone by Continue', async () => {
    let releaseStep = () => {}
    mockApp({ step: 'model', done: false }, ready, {
      'setup.set': (_, real) => new Promise((resolve) => (releaseStep = () => resolve(real()))),
    })
    render(<StudioApp />)
    await screen.findByRole('radio', { name: /^Opus 5.5/ })
    fireEvent.click(button('Back'))
    expect(button('Continue').disabled && radio('Sonnet 5.5').matches(':disabled')).toBe(true)
    await act(async () => releaseStep())
    expect(await screen.findByRole('region', { name: 'Check your Mac' })).toBeTruthy()
    expect(calls('settings.set')).toEqual([])
  })

  it('keeps a running sign-in, and a sign-in that ends there adds its models and Astra, keeping the pick', async () => {
    const store = mockApp({ step: 'model', done: false }, ready)
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('radio', { name: /^Sonnet 5.5/ }))
    await emit({ type: 'login', provider: 'openai-codex', step: 'open', url: 'https://auth.example/device', code: 'ABCD-1234' })
    expect(screen.getByTestId('sign-in').textContent).toContain('ABCD-1234')
    store.logins = bothIn
    await emit({ type: 'login', provider: 'openai-codex', step: 'done' })
    expect(await screen.findByRole('radio', { name: /^GPT 6.1 Sol/ })).toBeTruthy()
    expect(astra().disabled).toBe(false)
    expect(astra().checked).toBe(true)
    expect(radio('Sonnet 5.5').checked).toBe(true)
  })

  it('goes Back to Check your Mac', async () => {
    mockApp({ step: 'model', done: false }, ready)
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('heading', { name: 'Your Mac is ready' })).toBeTruthy()
    expect(saved()).toEqual([{ step: 'check', done: false }])
    expect(calls('settings.set')).toEqual([])
  })
})

describe('setup: ready', () => {
  it('sums up the agent, the slicer, the printer, and the build tools, with no agent tools line', async () => {
    mockApp({ step: 'ready', done: false }, { ...ready, logins: bothIn })
    render(<StudioApp />)
    expect(await screen.findByText('Claude, Opus 5.5. Astra helps with drawings.')).toBeTruthy()
    expect(await screen.findByText('Bambu Studio')).toBeTruthy()
    expect(await screen.findByText('uv 0.9.2, Python 3.12.1')).toBeTruthy()
    expect(await screen.findByText('Bambu Lab P2S, 0.4 mm, PETG Basic')).toBeTruthy()
    expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual(['Agent', 'Slicer', 'Printer', 'Build tools'])
    expect(summary('agent')).toBe('Claude, Opus 5.5. Astra helps with drawings.')
  })

  it('names a Bambu Studio that cannot slice, with the reason', async () => {
    const detail = 'Bambu Studio 02.07.00.00 is installed. The app needs 02.08.02.61.'
    mockApp({ step: 'ready', done: false }, { ...ready, slicer: { found: 'other', detail } })
    render(<StudioApp />)
    expect(await screen.findByText(`Not usable. ${detail}`)).toBeTruthy()
  })

  it('names a missing slicer', async () => {
    mockApp({ step: 'ready', done: false }, { ...ready, slicer: { found: 'none' } })
    render(<StudioApp />)
    expect(await screen.findByText('Not found. You get guides and STL files, but no 3MF.')).toBeTruthy()
  })
})

describe('setup: your printer', () => {
  const field = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
  const shown = (name: string) => within(field(name)).getByRole('option', { selected: true }).textContent
  const found = () => Object.fromEntries([...screen.getByTestId('printer-found').querySelectorAll('div')].map((row) => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]))

  it('shows the printer Bambu Studio last used, and Looks right saves it', async () => {
    const store = mockApp({ step: 'printer', done: false }, ready)
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Is this your printer?' })).toBeTruthy()
    expect(found()).toEqual({ Printer: 'Bambu Lab P2S', Nozzle: '0.4 mm', Filament: 'Bambu PETG Basic', Plate: 'SuperTack Plate', Quality: '0.20 mm Standard' })
    fireEvent.click(button('Looks right'))
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeTruthy()
    expect(calls('printer.set')).toEqual([{ ...P2S, plate: 'Supertack Plate' }])
    expect(store.settings.printer).toEqual({ ...P2S, plate: 'Supertack Plate' })
  })

  it('says the plate is the default when Bambu Studio recorded none', async () => {
    mockApp({ step: 'printer', done: false }, { ...ready, lastUsed: { ...lastUsedP2S, plate: null } })
    render(<StudioApp />)
    expect(await screen.findByText(/The plate is this printer’s default, because Bambu Studio did not record one\./)).toBeTruthy()
    expect(screen.queryByText('Read from the settings you last used in Bambu Studio.')).toBeNull()
  })

  it('changes to another printer, which starts with its own defaults, and Saves it for Ready to name', async () => {
    mockApp({ step: 'printer', done: false }, ready)
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    expect(await screen.findByRole('heading', { name: 'Pick your printer' })).toBeTruthy()
    expect([shown('Printer'), shown('Nozzle'), shown('Filament'), shown('Plate'), shown('Quality')]).toEqual([
      'Bambu Lab P2S',
      '0.4 mm',
      'Bambu PETG Basic',
      'SuperTack Plate',
      '0.20 mm Standard',
    ])
    fireEvent.change(field('Printer'), { target: { value: 'Bambu Lab A1 mini' } })
    expect([shown('Nozzle'), shown('Filament'), shown('Plate'), shown('Quality')]).toEqual(['0.4 mm', 'Bambu PLA Basic', 'SuperTack Plate', '0.20 mm Standard'])
    fireEvent.change(field('Filament'), { target: { value: 'Bambu PETG Basic @BBL A1M' } })
    fireEvent.click(button('Save'))
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeTruthy()
    expect(calls('printer.set')).toEqual([
      { machine: 'Bambu Lab A1 mini 0.4 nozzle', process: '0.20mm Standard @BBL A1M', filament: 'Bambu PETG Basic @BBL A1M', plate: 'Supertack Plate' },
    ])
    expect(await screen.findByText('Bambu Lab A1 mini, 0.4 mm, PETG Basic')).toBeTruthy()
    fireEvent.click(button('Start a project'))
    expect((await screen.findByTestId('printer')).querySelector('.printer-name')?.textContent).toBe('A1 mini')
  })

  it('opens the pick on the saved printer when Bambu Studio never ran, and Back goes to Pick a model', async () => {
    mockApp({ step: 'printer', done: false }, { ...ready, lastUsed: null })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Pick your printer' })).toBeTruthy()
    expect([shown('Printer'), shown('Nozzle'), shown('Filament'), shown('Plate')]).toEqual(['Bambu Lab P2S', '0.4 mm', 'Bambu PETG Basic', 'Textured PEI Plate'])
    fireEvent.click(button('Back'))
    expect(await screen.findByRole('heading', { name: 'Pick your default model' })).toBeTruthy()
    expect(calls('printer.set')).toEqual([])
  })

  it('opens the pick on the printer read when Bambu Studio recorded no filament', async () => {
    mockApp({ step: 'printer', done: false }, { ...ready, lastUsed: { ...lastUsedP2S, machine: preset('Bambu Lab P2S 0.6 nozzle'), filament: null } })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Pick your printer' })).toBeTruthy()
    expect([shown('Printer'), shown('Nozzle'), shown('Filament'), shown('Plate')]).toEqual(['Bambu Lab P2S', '0.6 mm', 'Bambu PLA Basic', 'SuperTack Plate'])
  })

  it('shows why a printer was refused and stays on the step', async () => {
    mockApp({ step: 'printer', done: false }, ready, {
      'printer.set': () => Promise.reject('filament preset "Bambu PETG Basic @BBL P2S 0.4 nozzle" is not compatible with machine "Bambu Lab P2S 0.4 nozzle"'),
    })
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Looks right' }))
    expect((await screen.findByRole('alert')).textContent).toContain('is not compatible with machine')
    expect(screen.getByRole('heading', { name: 'Is this your printer?' })).toBeTruthy()
    expect(saved()).toEqual([])
    expect(button('Looks right').disabled).toBe(false)
  })

  it('keeps Save and the fields off while Back saves, so a late Save cannot undo Back', async () => {
    let release = () => {}
    mockApp({ step: 'printer', done: false }, { ...ready, lastUsed: null }, { 'setup.set': (_, real) => new Promise((resolve) => (release = () => resolve(real()))) })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Pick your printer' })).toBeTruthy()
    fireEvent.click(button('Back'))
    expect(button('Save').disabled).toBe(true)
    expect(field('Printer').matches(':disabled')).toBe(true)
    await act(async () => release())
    expect(await screen.findByRole('heading', { name: 'Pick your default model' })).toBeTruthy()
    expect(calls('printer.set')).toEqual([])
  })

  it('opens the pick and says why when Bambu Studio’s settings cannot be read', async () => {
    mockApp({ step: 'printer', done: false }, ready)
    const app = invokeMock.getMockImplementation()
    invokeMock.mockImplementation((command: string, args: unknown) =>
      command === 'bambu_last_used' ? Promise.reject('BambuStudio.conf: invalid JSON') : app?.(command, args),
    )
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'Pick your printer' })).toBeTruthy()
    expect(screen.getByText(/BambuStudio\.conf: invalid JSON/)).toBeTruthy()
    fireEvent.click(button('Save'))
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeTruthy()
  })

  it('shows why the printer list failed, and Try again reads it again', async () => {
    mockApp({ step: 'printer', done: false }, ready)
    const app = invokeMock.getMockImplementation()
    let failures = 1
    invokeMock.mockImplementation((command: string, args: unknown) =>
      command === 'studio_printers' && failures-- > 0 ? Promise.reject('BBL.json: invalid JSON') : app?.(command, args),
    )
    render(<StudioApp />)
    expect(await screen.findByText(/BBL\.json: invalid JSON/)).toBeTruthy()
    expect(button('Back').disabled).toBe(false)
    fireEvent.click(button('Try again'))
    expect(await screen.findByRole('heading', { name: 'Is this your printer?' })).toBeTruthy()
  })

  it.each([
    ['no Bambu Studio', { found: 'none' as const }],
    ['a Bambu Studio that cannot slice', { found: 'other' as const, detail: 'Bambu Studio 02.07.00.00 is installed.' }],
  ])('offers Try again when the save that passes the step with %s fails', async (_, slicer) => {
    let failures = 1
    mockApp({ step: 'printer', done: false }, { ...ready, slicer }, {
      'setup.set': (_, real) => (failures-- > 0 ? Promise.reject('disk full') : Promise.resolve(real())),
    })
    render(<StudioApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeTruthy()
  })

  it('passes on to Ready without a slicer, and Ready names the printer already saved', async () => {
    mockApp({ step: 'printer', done: false }, { ...ready, slicer: { found: 'none' } })
    render(<StudioApp />)
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeTruthy()
    expect(saved()).toEqual([{ step: 'ready', done: false }])
    expect(invokeMock.mock.calls.some(([command]) => command === 'studio_printers')).toBe(false)
    expect(await screen.findByText('Bambu Lab P2S, 0.4 mm, PETG Basic')).toBeTruthy()
  })
})
