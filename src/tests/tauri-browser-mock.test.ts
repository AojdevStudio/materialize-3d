// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { describe, expect, it } from 'vitest'
import { installTauriBrowserMock } from '../dev/tauriBrowserMock'

describe('tauri browser mock', () => {
  it('switch_printer selects the printer named by configId, like the real command', async () => {
    installTauriBrowserMock()
    const config = await invoke<{ id: string }>('add_printer_config', {
      name: 'Workshop P2S',
      host: '192.0.2.10',
      serial: '01P00A000000000',
      accessCode: '12345678',
    })

    await invoke('switch_printer', { configId: config.id })

    const state = await invoke<{ selectedPrinterId: string | null }>('get_app_state')
    expect(state.selectedPrinterId).toBe(config.id)
  })
})
