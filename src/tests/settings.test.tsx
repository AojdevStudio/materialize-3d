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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

// pi-ai mock: SettingsPanel imports model-config (provider/model catalog)
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn((_provider: string, _modelId: string) => ({
    id: _modelId,
    provider: _provider,
    api: 'messages',
  })),
  getProviders: vi.fn(() => ['anthropic', 'openai']),
  getModels: vi.fn((_provider: string) => [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4', provider: _provider, api: 'messages' },
  ]),
}))

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

  it('shows slicer warning when list_profiles fails', async () => {
    invokeMock.mockRejectedValue(new Error('orca not found'))
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
    expect(screen.getByText(/OrcaSlicer not found/)).toBeTruthy()
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

describe('Slicer diagnostic in SettingsPanel', () => {
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

    const { useSettingsStore, SETTINGS_DEFAULT_STATE } = await import('../stores/settings')
    useSettingsStore.setState({ ...SETTINGS_DEFAULT_STATE, settings: structuredClone(DEFAULT_SETTINGS), loaded: true })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows OrcaSlicer ✓ when profiles load successfully', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    await waitFor(() => {
      expect(screen.getByTestId('slicer-ok')).toBeTruthy()
    })
    expect(screen.getByText('OrcaSlicer ✓')).toBeTruthy()
  })

  it('shows install warning when profiles fail to load', async () => {
    invokeMock.mockRejectedValue(new Error('orca not found'))
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    await waitFor(() => {
      expect(screen.getByTestId('slicer-warning')).toBeTruthy()
    })
    expect(screen.getByText(/install it and restart the app/)).toBeTruthy()
  })

  it('renders Slicer section label', async () => {
    invokeMock.mockResolvedValue(MOCK_PROFILES)
    const { SettingsPanel } = await import('../components/SettingsPanel')
    render(React.createElement(SettingsPanel, { isOpen: true, onClose: vi.fn() }))

    expect(screen.getByText('Slicer')).toBeTruthy()
  })
})
