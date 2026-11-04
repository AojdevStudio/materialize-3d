// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTauriBrowserMock } from '../dev/tauriBrowserMock'

const addPrinter = (serial: string) =>
  invoke<{ id: string }>('add_printer_config', {
    name: 'Workshop P2S',
    host: '192.0.2.10',
    serial,
    accessCode: '12345678',
  })

const printerStatus = () => invoke<{ isConnected: boolean }>('get_printer_status')

describe('tauri browser mock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    installTauriBrowserMock()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('switch_printer selects the printer named by configId, like the real command', async () => {
    const config = await addPrinter('01P00A000000000')

    await invoke('switch_printer', { configId: config.id })

    const state = await invoke<{ selectedPrinterId: string | null }>('get_app_state')
    expect(state.selectedPrinterId).toBe(config.id)
  })

  it('a disconnect before a pending connect finishes keeps the printer disconnected', async () => {
    const config = await addPrinter('01P00B000000000')

    await invoke('connect_printer_by_config', { configId: config.id })
    await invoke('disconnect_printer')
    await vi.advanceTimersByTimeAsync(2000)

    expect((await printerStatus()).isConnected).toBe(false)
  })

  it('switch_printer to an unknown config disconnects the current printer, like the real command', async () => {
    const config = await addPrinter('01P00C000000000')
    await invoke('connect_printer_by_config', { configId: config.id })
    await vi.advanceTimersByTimeAsync(2000)
    expect((await printerStatus()).isConnected).toBe(true)

    await expect(invoke('switch_printer', { configId: 'missing' })).rejects.toThrow(
      'printer config missing not found',
    )

    expect((await printerStatus()).isConnected).toBe(false)
  })
})
