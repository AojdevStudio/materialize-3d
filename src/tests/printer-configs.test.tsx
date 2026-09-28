// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

function emitEvent<T>(name: string, payload: T) {
  const handler = eventHandlers.get(name)
  if (!handler) {
    throw new Error(`No handler registered for ${name}`)
  }
  act(() => {
    handler({ payload })
  })
}

describe('printerConfigs store', () => {
  beforeEach(async () => {
    const { usePrinterConfigStore, PRINTER_CONFIG_DEFAULT_STATE } = await import('../stores/printerConfigs')
    usePrinterConfigStore.setState(PRINTER_CONFIG_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('initializes with empty configs and null selectedPrinterId', async () => {
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')
    const state = usePrinterConfigStore.getState()
    expect(state.configs).toEqual([])
    expect(state.selectedPrinterId).toBeNull()
  })

  it('setConfigs updates the configs array', async () => {
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')
    const mockConfigs = [
      { id: 'pc-1', name: 'Lab P2S', host: '192.0.2.136', serial: 'ABC123', isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'pc-2', name: 'Workshop X1C', host: '192.0.2.200', serial: 'DEF456', isDefault: false, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    ]

    act(() => {
      usePrinterConfigStore.getState().setConfigs(mockConfigs)
    })

    expect(usePrinterConfigStore.getState().configs).toHaveLength(2)
    expect(usePrinterConfigStore.getState().configs[0].name).toBe('Lab P2S')
  })

  it('setSelectedPrinterId tracks selected printer', async () => {
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')

    act(() => {
      usePrinterConfigStore.getState().setSelectedPrinterId('pc-1')
    })

    expect(usePrinterConfigStore.getState().selectedPrinterId).toBe('pc-1')

    act(() => {
      usePrinterConfigStore.getState().setSelectedPrinterId(null)
    })

    expect(usePrinterConfigStore.getState().selectedPrinterId).toBeNull()
  })

  it('usePrinterConfigEvents subscribes to printer-configs:changed', async () => {
    eventHandlers.clear()
    listenMock.mockReset()
    unlistenMock.mockReset()

    listenMock.mockImplementation(async (name: string, handler: EventHandler) => {
      eventHandlers.set(name, handler)
      return () => {
        unlistenMock(name)
        eventHandlers.delete(name)
      }
    })

    const { usePrinterConfigStore } = await import('../stores/printerConfigs')
    const { usePrinterConfigEvents } = await import('../stores/printerConfigs')

    function TestBridge() {
      usePrinterConfigEvents()
      return null
    }

    render(React.createElement(TestBridge))

    expect(listenMock).toHaveBeenCalledWith('printer-configs:changed', expect.any(Function))

    const newConfigs = [
      { id: 'pc-1', name: 'My Printer', host: '192.168.1.100', serial: 'XYZ', isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]
    emitEvent('printer-configs:changed', newConfigs)

    expect(usePrinterConfigStore.getState().configs).toHaveLength(1)
    expect(usePrinterConfigStore.getState().configs[0].name).toBe('My Printer')
  })
})

describe('PrinterSelector component', () => {
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

    const { usePrinterConfigStore, PRINTER_CONFIG_DEFAULT_STATE } = await import('../stores/printerConfigs')
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    usePrinterConfigStore.setState(PRINTER_CONFIG_DEFAULT_STATE)
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders nothing when closed', async () => {
    const { PrinterSelector } = await import('../components/PrinterSelector')
    const { container } = render(React.createElement(PrinterSelector, { open: false, onClose: vi.fn() }))
    expect(container.innerHTML).toBe('')
  })

  it('shows empty state when no configs exist', async () => {
    const { PrinterSelector } = await import('../components/PrinterSelector')
    render(React.createElement(PrinterSelector, { open: true, onClose: vi.fn() }))

    expect(screen.getByText('No printers configured')).toBeTruthy()
    expect(screen.getByText('+ Add your first printer')).toBeTruthy()
  })

  it('renders saved printer configs', async () => {
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')

    act(() => {
      usePrinterConfigStore.getState().setConfigs([
        { id: 'pc-1', name: 'Lab P2S', host: '192.0.2.136', serial: 'ABC123', isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'pc-2', name: 'Workshop X1C', host: '192.0.2.200', serial: 'DEF456', isDefault: false, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      ])
    })

    const { PrinterSelector } = await import('../components/PrinterSelector')
    render(React.createElement(PrinterSelector, { open: true, onClose: vi.fn() }))

    expect(screen.getByText('Lab P2S')).toBeTruthy()
    expect(screen.getByText('Workshop X1C')).toBeTruthy()
    expect(screen.getByText('192.0.2.136')).toBeTruthy()
    expect(screen.getByText('192.0.2.200')).toBeTruthy()
    expect(screen.getByText('default')).toBeTruthy()
  })

  it('switch action calls invoke with switch_printer', async () => {
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')

    act(() => {
      usePrinterConfigStore.getState().setConfigs([
        { id: 'pc-1', name: 'Lab P2S', host: '192.0.2.136', serial: 'ABC123', isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ])
    })

    invokeMock.mockResolvedValue({})

    const { PrinterSelector } = await import('../components/PrinterSelector')
    render(React.createElement(PrinterSelector, { open: true, onClose: vi.fn() }))

    const switchBtn = screen.getByLabelText('Switch to Lab P2S')
    await act(async () => {
      fireEvent.click(switchBtn)
    })

    expect(invokeMock).toHaveBeenCalledWith('switch_printer', { configId: 'pc-1' })
  })

  it('delete action calls invoke with delete_printer_config', async () => {
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')

    act(() => {
      usePrinterConfigStore.getState().setConfigs([
        { id: 'pc-1', name: 'Lab P2S', host: '192.0.2.136', serial: 'ABC123', isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ])
    })

    invokeMock.mockResolvedValue(true)

    const { PrinterSelector } = await import('../components/PrinterSelector')
    render(React.createElement(PrinterSelector, { open: true, onClose: vi.fn() }))

    const deleteBtn = screen.getByLabelText('Delete Lab P2S')
    await act(async () => {
      fireEvent.click(deleteBtn)
    })

    expect(invokeMock).toHaveBeenCalledWith('delete_printer_config', { id: 'pc-1' })
  })

  it('add form shows password input for access code', async () => {
    const { PrinterSelector } = await import('../components/PrinterSelector')
    render(React.createElement(PrinterSelector, { open: true, onClose: vi.fn() }))

    // Click "Add your first printer" to reveal the form
    const addBtn = screen.getByText('+ Add your first printer')
    fireEvent.click(addBtn)

    const accessCodeInput = screen.getByPlaceholderText('••••••••')
    expect(accessCodeInput.getAttribute('type')).toBe('password')
  })

  it('add form submits with add_printer_config invoke', async () => {
    const mockConfig = {
      id: 'pc-new',
      name: 'New Printer',
      host: '192.168.1.50',
      serial: 'SER123',
      isDefault: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    invokeMock.mockResolvedValue(mockConfig)

    const { PrinterSelector } = await import('../components/PrinterSelector')
    render(React.createElement(PrinterSelector, { open: true, onClose: vi.fn() }))

    // Open add form
    fireEvent.click(screen.getByText('+ Add your first printer'))

    // Fill fields
    fireEvent.change(screen.getByPlaceholderText('My Bambu P1S'), { target: { value: 'New Printer' } })
    fireEvent.change(screen.getByPlaceholderText('192.0.2.136'), { target: { value: '192.168.1.50' } })
    fireEvent.change(screen.getByPlaceholderText('01P00A000000000'), { target: { value: 'SER123' } })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'secret123' } })

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Printer' }))
    })

    expect(invokeMock).toHaveBeenCalledWith('add_printer_config', {
      name: 'New Printer',
      host: '192.168.1.50',
      serial: 'SER123',
      accessCode: 'secret123',
    })
  })
})

describe('Toolbar with PrinterSelector', () => {
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

    const { usePrinterConfigStore, PRINTER_CONFIG_DEFAULT_STATE } = await import('../stores/printerConfigs')
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    usePrinterConfigStore.setState(PRINTER_CONFIG_DEFAULT_STATE)
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('shows active config name in toolbar badge', async () => {
    const { usePrinterConfigStore } = await import('../stores/printerConfigs')

    act(() => {
      usePrinterConfigStore.getState().setConfigs([
        { id: 'pc-1', name: 'Lab P2S', host: '192.0.2.136', serial: 'ABC123', isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ])
      usePrinterConfigStore.getState().setSelectedPrinterId('pc-1')
    })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    expect(screen.getByText('Lab P2S')).toBeTruthy()
  })

  it('falls back to printer store name when no config selected', async () => {
    const { usePrinterStore } = await import('../stores/printer')

    act(() => {
      usePrinterStore.getState().applySnapshot({ name: 'AOJDevStudio' })
    })

    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    expect(screen.getByText('AOJDevStudio')).toBeTruthy()
  })

  it('opens selector popover on printer badge click', async () => {
    const { Toolbar } = await import('../components/Toolbar')
    render(React.createElement(Toolbar))

    const badge = screen.getByLabelText('printer connection status')
    fireEvent.click(badge)

    expect(screen.getByRole('dialog', { name: 'Printer selector' })).toBeTruthy()
  })
})
