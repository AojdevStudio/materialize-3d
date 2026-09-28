import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import useTauriEvent from '../hooks/useTauriEvent'

export interface PrinterConfig {
  id: string
  name: string
  host: string
  serial: string
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

interface PrinterConfigState {
  configs: PrinterConfig[]
  selectedPrinterId: string | null
  setConfigs: (configs: PrinterConfig[]) => void
  setSelectedPrinterId: (id: string | null) => void
}

export const PRINTER_CONFIG_DEFAULT_STATE: Pick<PrinterConfigState, 'configs' | 'selectedPrinterId'> = {
  configs: [],
  selectedPrinterId: null,
}

export const usePrinterConfigStore = create<PrinterConfigState>()((set) => ({
  ...PRINTER_CONFIG_DEFAULT_STATE,
  setConfigs: (configs) => set({ configs }),
  setSelectedPrinterId: (id) => set({ selectedPrinterId: id }),
}))

/**
 * Subscribe to `printer-configs:changed` Tauri event and hydrate on mount.
 * Call once in `App.tsx` alongside other event hooks.
 */
export function usePrinterConfigEvents() {
  useTauriEvent<PrinterConfig[]>('printer-configs:changed', ({ payload }) => {
    console.debug('event received:', 'printer-configs:changed', payload)
    usePrinterConfigStore.getState().setConfigs(payload)
  })
}

/**
 * Hydrate the config store from the backend on app startup.
 * Call once during initial state bridge setup.
 */
export async function hydratePrinterConfigs(): Promise<void> {
  try {
    const configs = await invoke<PrinterConfig[]>('get_printer_configs')
    if (Array.isArray(configs)) {
      usePrinterConfigStore.getState().setConfigs(configs)
      console.debug('printer-configs:hydrated', configs.length)
    }
  } catch (error) {
    console.error('failed to hydrate printer configs', error)
  }
}
