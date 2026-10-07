// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type EventHandler<T = unknown> = (event: { payload: T }) => void

const listenMock = vi.fn()
const invokeMock = vi.fn()
const unlistenMock = vi.fn()
const eventHandlers = new Map<string, EventHandler>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

// agent_* commands go to a small fake Rust agent, bambu_studio_status to a fixed
// "found" status; everything else to invokeMock
const agentInvokeMock = vi.fn()
const BAMBU_FOUND = {
  state: 'found',
  path: '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
  version: '02.08.02.61',
  chosenPath: null,
  validatedVersions: ['02.08.02.61'],
  downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61',
}
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: [string, unknown?]) =>
    args[0].startsWith('agent_')
      ? agentInvokeMock(...args)
      : args[0] === 'bambu_studio_status'
        ? Promise.resolve(BAMBU_FOUND)
        : invokeMock(...args),
}))

let agentKeys = new Set<string>()
const AGENT_MODELS: Record<string, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-fable-5-1'],
  openai: ['gpt-6-astra', 'gpt-6.1-sol'],
}
let agentModel = { provider: 'anthropic', model: 'claude-opus-5-5' }
/** Stands in for the Rust agent: an empty model means the provider's first. */
function fakeAgent(cmd: string, args?: Record<string, string>) {
  if (cmd === 'agent_set_api_key') agentKeys.add(args!.provider!)
  if (cmd === 'agent_clear_api_key') agentKeys.delete(args!.provider!)
  if (cmd === 'agent_set_model') {
    agentModel = { provider: args!.provider!, model: args!.model! || AGENT_MODELS[args!.provider!]![0]! }
  }
  return Promise.resolve({ ...agentModel, models: AGENT_MODELS[agentModel.provider], hasApiKey: agentKeys.has(agentModel.provider) })
}

function emitEvent<T>(name: string, payload: T) {
  const handler = eventHandlers.get(name)
  if (!handler) {
    throw new Error(`No handler registered for ${name}`)
  }
  act(() => {
    handler({ payload })
  })
}

const DEFAULT_SETTINGS: Record<string, string> = {
  'default.quality': '0.20mm',
  'default.filament': 'Bambu PLA Basic',
  'notifications.print_complete': 'true',
  'notifications.print_failed': 'true',
  'notifications.filament_low': 'false',
  'connection.auto_connect': 'false',
}

const MOCK_PROFILES = {
  qualities: ['0.08mm', '0.12mm', '0.16mm', '0.20mm', '0.28mm'],
  filaments: ['Bambu PLA Basic', 'Bambu PLA Matte', 'Bambu PETG Basic', 'Bambu ABS', 'Generic PLA', 'Generic PETG'],
}

describe('useSettingsStore', () => {
  beforeEach(async () => {
    const { useSettingsStore, SETTINGS_DEFAULT_STATE } = await import('../stores/settings')
    useSettingsStore.setState(SETTINGS_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('initializes with empty settings and loaded=false', async () => {
    const { useSettingsStore } = await import('../stores/settings')
    const state = useSettingsStore.getState()
    expect(state.settings).toEqual({})
    expect(state.loaded).toBe(false)
  })

  it('hydrateSettings populates state from backend', async () => {
    invokeMock.mockResolvedValueOnce(structuredClone(DEFAULT_SETTINGS))
    const { useSettingsStore, hydrateSettings } = await import('../stores/settings')

    await act(async () => {
      await hydrateSettings()
    })

    const state = useSettingsStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.settings['default.quality']).toBe('0.20mm')
    expect(state.settings['notifications.print_complete']).toBe('true')
    expect(invokeMock).toHaveBeenCalledWith('get_settings')
  })

  it('settings:changed event updates store', async () => {
    eventHandlers.clear()
    listenMock.mockReset()

    listenMock.mockImplementation(async (name: string, handler: EventHandler) => {
      eventHandlers.set(name, handler)
      return () => { eventHandlers.delete(name) }
    })

    const { useSettingsStore, useSettingsEvents } = await import('../stores/settings')

    function TestBridge() {
      useSettingsEvents()
      return null
    }

    render(React.createElement(TestBridge))

    expect(listenMock).toHaveBeenCalledWith('settings:changed', expect.any(Function))

    const updated = { ...DEFAULT_SETTINGS, 'default.quality': '0.12mm' }
    emitEvent('settings:changed', updated)

    expect(useSettingsStore.getState().settings['default.quality']).toBe('0.12mm')
    expect(useSettingsStore.getState().loaded).toBe(true)
  })

  it('getSetting returns value for existing key', async () => {
    const { useSettingsStore } = await import('../stores/settings')
    useSettingsStore.getState().setSettings(DEFAULT_SETTINGS)

    expect(useSettingsStore.getState().getSetting('default.quality')).toBe('0.20mm')
  })

  it('getSetting returns undefined for missing key', async () => {
    const { useSettingsStore } = await import('../stores/settings')
    useSettingsStore.getState().setSettings(DEFAULT_SETTINGS)

    expect(useSettingsStore.getState().getSetting('nonexistent.key')).toBeUndefined()
  })

  it('getSettingBool returns boolean true for "true"', async () => {
    const { useSettingsStore } = await import('../stores/settings')
    useSettingsStore.getState().setSettings(DEFAULT_SETTINGS)

    expect(useSettingsStore.getState().getSettingBool('notifications.print_complete')).toBe(true)
  })

  it('getSettingBool returns false for non-"true" values', async () => {
    const { useSettingsStore } = await import('../stores/settings')
    useSettingsStore.getState().setSettings(DEFAULT_SETTINGS)

    expect(useSettingsStore.getState().getSettingBool('notifications.filament_low')).toBe(false)
    expect(useSettingsStore.getState().getSettingBool('nonexistent')).toBe(false)
  })
})

describe('SettingsPanel component', () => {
  beforeEach(async () => {
    agentKeys = new Set()
    agentModel = { provider: 'anthropic', model: 'claude-opus-5-5' }
    agentInvokeMock.mockReset()
    agentInvokeMock.mockImplementation(fakeAgent)
    const { useAgentStore } = await import('../stores/agent')
    useAgentStore.setState({ status: null })
    eventHandlers.clear()
    listenMock.mockReset()
    invokeMock.mockReset()
    unlistenMock.mockReset()

    listenMock.mockImplementation(async (name: string, handler: EventHandler) => {
      eventHandlers.set(name, handler)
      return () => {
        unlistenMock(name)
        eventHandlers.delete(name)
      }
    })

    const { useSettingsStore, SETTINGS_DEFAULT_STATE } = await import('../stores/settings')
    useSettingsStore.setState({ ...SETTINGS_DEFAULT_STATE, settings: structuredClone(DEFAULT_SETTINGS), loaded: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when closed', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    const { container } = render(React.createElement(SettingsPanel, { isOpen: false, onClose: vi.fn() }))
    expect(container.innerHTML).toBe('')
  })

  it('renders all sections when open', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    expect(screen.getByText('Defaults')).toBeTruthy()
    expect(screen.getByText('Notifications')).toBeTruthy()
    expect(screen.getByText('Connection')).toBeTruthy()
  })

  it('populates quality and filament selects from list_profiles', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('list_profiles')
    })

    // Wait for profiles to populate
    await waitFor(() => {
      expect(screen.getByText('0.08mm')).toBeTruthy()
    })

    expect(screen.getByText('0.28mm')).toBeTruthy()
    expect(screen.getByText('Bambu PLA Matte')).toBeTruthy()
    expect(screen.getByText('Generic PETG')).toBeTruthy()
  })

  it('checkbox toggle invokes update_settings', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    // notifications.filament_low is currently false, toggle it on
    const filamentCheckbox = screen.getByLabelText('Filament low') as HTMLInputElement
    expect(filamentCheckbox.checked).toBe(false)

    invokeMock.mockResolvedValue(undefined)
    await act(async () => {
      fireEvent.click(filamentCheckbox)
    })

    expect(invokeMock).toHaveBeenCalledWith('update_settings', { settings: { 'notifications.filament_low': 'true' } })
  })

  it('panel closes on Escape', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const onClose = vi.fn()
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose }))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('panel closes on outside click', async () => {
    vi.useFakeTimers()
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const onClose = vi.fn()
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement('div', null,
      React.createElement('div', { 'data-testid': 'outside' }, 'Outside'),
      React.createElement(SettingsPanel, { isOpen: true, onClose }),
    ))

    // Advance past the setTimeout(0) delay
    vi.advanceTimersByTime(1)

    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onClose).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('stores and clears the agent API key without ever showing it', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    const input = (await screen.findByTestId('agent-api-key')) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(screen.getByTestId('agent-key-state').textContent).toBe('No key stored')

    fireEvent.change(input, { target: { value: 'sk-secret-123' } })
    fireEvent.click(screen.getByTestId('agent-api-key-save'))

    await waitFor(() => expect(screen.getByTestId('agent-key-state').textContent).toBe('Key stored'))
    expect(agentInvokeMock).toHaveBeenCalledWith('agent_set_api_key', { provider: 'anthropic', apiKey: 'sk-secret-123' })
    expect(input.value).toBe('')
    expect(document.body.innerHTML).not.toContain('sk-secret-123')

    fireEvent.click(screen.getByTestId('agent-api-key-clear'))
    await waitFor(() => expect(screen.getByTestId('agent-key-state').textContent).toBe('No key stored'))
    expect(agentInvokeMock).toHaveBeenCalledWith('agent_clear_api_key', { provider: 'anthropic' })
  })

  it('provider and model selects call agent_set_model', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    fireEvent.change(await screen.findByTestId('agent-model'), { target: { value: 'claude-fable-5-1' } })
    await waitFor(() =>
      expect(agentInvokeMock).toHaveBeenCalledWith('agent_set_model', { provider: 'anthropic', model: 'claude-fable-5-1' }),
    )

    fireEvent.change(screen.getByTestId('agent-provider'), { target: { value: 'openai' } })
    await waitFor(() => expect((screen.getByTestId('agent-provider') as HTMLSelectElement).value).toBe('openai'))
    expect(agentInvokeMock).toHaveBeenLastCalledWith('agent_set_model', { provider: 'openai', model: '' })
    expect((screen.getByTestId('agent-model') as HTMLSelectElement).value).toBe('gpt-6-astra')
  })

  it('the model select lists exactly the models the agent status offers', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    const select = (await screen.findByTestId('agent-model')) as HTMLSelectElement
    expect([...select.options].map((o) => [o.value, o.text])).toEqual([
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-fable-5-1', 'Fable 5.1'],
    ])

    fireEvent.change(screen.getByTestId('agent-provider'), { target: { value: 'openai' } })
    await waitFor(() =>
      expect([...select.options].map((o) => [o.value, o.text])).toEqual([
        ['gpt-6-astra', 'GPT-6 Astra'],
        ['gpt-6.1-sol', 'GPT-6.1 Sol'],
      ]),
    )
  })

  it('renders checkbox labels for all notification types', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    expect(screen.getByText('Print complete')).toBeTruthy()
    expect(screen.getByText('Print failed')).toBeTruthy()
    expect(screen.getByText('Filament low')).toBeTruthy()
    expect(screen.getByText('Auto-connect on launch')).toBeTruthy()
  })
})

describe('Toolbar with SettingsPanel', () => {
  beforeEach(async () => {
    eventHandlers.clear()
    listenMock.mockReset()
    invokeMock.mockReset()
    unlistenMock.mockReset()

    listenMock.mockImplementation(async (name: string, handler: EventHandler) => {
      eventHandlers.set(name, handler)
      return () => {
        unlistenMock(name)
        eventHandlers.delete(name)
      }
    })

    invokeMock.mockResolvedValue(MOCK_PROFILES)

    const { usePrinterConfigStore, PRINTER_CONFIG_DEFAULT_STATE } = await import('../stores/printerConfigs')
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useSettingsStore, SETTINGS_DEFAULT_STATE } = await import('../stores/settings')
    const { useUiStore, UI_DEFAULT_STATE } = await import('../stores/ui')
    useUiStore.setState(UI_DEFAULT_STATE)
    usePrinterConfigStore.setState(PRINTER_CONFIG_DEFAULT_STATE)
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useSettingsStore.setState({ ...SETTINGS_DEFAULT_STATE, settings: structuredClone(DEFAULT_SETTINGS), loaded: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('⚙ button toggles settings panel', async () => {
    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const settingsBtn = screen.getByLabelText('Settings')
    fireEvent.click(settingsBtn)

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()

    // Toggle off
    fireEvent.click(settingsBtn)
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })

  it('opening settings closes printer selector', async () => {
    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    // Open printer selector first
    const printerBadge = screen.getByLabelText('printer connection status')
    fireEvent.click(printerBadge)
    expect(screen.getByRole('dialog', { name: 'Printer selector' })).toBeTruthy()

    // Now open settings — printer selector should close
    const settingsBtn = screen.getByLabelText('Settings')
    fireEvent.click(settingsBtn)

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Printer selector' })).toBeNull()
  })

  it('opening printer selector closes settings', async () => {
    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    // Open settings first
    const settingsBtn = screen.getByLabelText('Settings')
    fireEvent.click(settingsBtn)
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy()

    // Now open printer selector — settings should close
    const printerBadge = screen.getByLabelText('printer connection status')
    fireEvent.click(printerBadge)

    expect(screen.getByRole('dialog', { name: 'Printer selector' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull()
  })
})

describe('Error recovery UI', () => {
  beforeEach(async () => {
    eventHandlers.clear()
    listenMock.mockReset()
    invokeMock.mockReset()
    unlistenMock.mockReset()

    listenMock.mockImplementation(async (name: string, handler: EventHandler) => {
      eventHandlers.set(name, handler)
      return () => {
        unlistenMock(name)
        eventHandlers.delete(name)
      }
    })

    invokeMock.mockResolvedValue(MOCK_PROFILES)

    const { usePrinterConfigStore, PRINTER_CONFIG_DEFAULT_STATE } = await import('../stores/printerConfigs')
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useSettingsStore, SETTINGS_DEFAULT_STATE } = await import('../stores/settings')
    usePrinterConfigStore.setState(PRINTER_CONFIG_DEFAULT_STATE)
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useSettingsStore.setState({ ...SETTINGS_DEFAULT_STATE, settings: structuredClone(DEFAULT_SETTINGS), loaded: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows error banner when offline with lastError', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    usePrinterStore.setState({ connectionState: 'offline', lastError: 'MQTT timeout' })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const alert = screen.getByRole('alert', { name: 'Connection error' })
    expect(alert).toBeTruthy()
    expect(screen.getByText('MQTT timeout')).toBeTruthy()
    expect(screen.getByLabelText('Retry connection')).toBeTruthy()
  })

  it('shows error banner when disconnected with lastError', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    usePrinterStore.setState({ connectionState: 'disconnected', lastError: 'Connection refused' })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const alert = screen.getByRole('alert', { name: 'Connection error' })
    expect(alert).toBeTruthy()
    expect(screen.getByText('Connection refused')).toBeTruthy()
  })

  it('hides error banner when connected', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    usePrinterStore.setState({ connectionState: 'connected_mqtt', lastError: null })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    expect(screen.queryByRole('alert', { name: 'Connection error' })).toBeNull()
  })

  it('hides error banner when offline but no lastError', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    usePrinterStore.setState({ connectionState: 'offline', lastError: null })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    expect(screen.queryByRole('alert', { name: 'Connection error' })).toBeNull()
  })

  it('retry button calls connect_printer_by_config when selectedPrinterId set', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')
    usePrinterStore.setState({ connectionState: 'offline', lastError: 'Timeout' })
    usePrinterConfigStore.setState({ selectedPrinterId: 'cfg-123' })

    invokeMock.mockResolvedValue(undefined)

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const retryBtn = screen.getByLabelText('Retry connection')
    await act(async () => { fireEvent.click(retryBtn) })

    expect(invokeMock).toHaveBeenCalledWith('connect_printer_by_config', { configId: 'cfg-123' })
  })

  it('retry button calls connect_printer when no selectedPrinterId', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')
    usePrinterStore.setState({ connectionState: 'offline', lastError: 'Timeout' })
    usePrinterConfigStore.setState({ selectedPrinterId: null })

    invokeMock.mockResolvedValue(undefined)

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const retryBtn = screen.getByLabelText('Retry connection')
    await act(async () => { fireEvent.click(retryBtn) })

    expect(invokeMock).toHaveBeenCalledWith('connect_printer', { credentialsPath: null })
  })

  it('disconnect button visible during reconnecting state', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    usePrinterStore.setState({ connectionState: 'reconnecting', lastError: 'Lost connection' })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const disconnectBtn = screen.getByLabelText('Disconnect')
    expect(disconnectBtn).toBeTruthy()
  })

  it('disconnect button calls disconnect_printer', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    usePrinterStore.setState({ connectionState: 'reconnecting', lastError: 'Lost connection' })

    invokeMock.mockResolvedValue(undefined)

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const disconnectBtn = screen.getByLabelText('Disconnect')
    await act(async () => { fireEvent.click(disconnectBtn) })

    expect(invokeMock).toHaveBeenCalledWith('disconnect_printer')
  })

  it('disconnect button not visible when offline (not reconnecting)', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    usePrinterStore.setState({ connectionState: 'offline', lastError: 'Timeout' })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    expect(screen.queryByLabelText('Disconnect')).toBeNull()
  })

  it('truncates long error messages', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    const longError = 'A'.repeat(100)
    usePrinterStore.setState({ connectionState: 'offline', lastError: longError })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const msg = screen.getByText(/A{10,}…/)
    expect(msg.textContent?.length).toBeLessThanOrEqual(81) // 80 chars + ellipsis
  })
})
