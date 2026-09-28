import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import useTauriEvent from '../hooks/useTauriEvent'

interface SettingsState {
  settings: Record<string, string>
  loaded: boolean
  setSettings: (map: Record<string, string>) => void
  getSetting: (key: string) => string | undefined
  getSettingBool: (key: string) => boolean
}

export const SETTINGS_DEFAULT_STATE: Pick<SettingsState, 'settings' | 'loaded'> = {
  settings: {},
  loaded: false,
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  ...SETTINGS_DEFAULT_STATE,
  setSettings: (map) => set({ settings: map, loaded: true }),
  getSetting: (key) => get().settings[key],
  getSettingBool: (key) => get().settings[key] === 'true',
}))

/**
 * Hydrate the settings store from the backend on app startup.
 * Call once during initial state bridge setup.
 */
export async function hydrateSettings(): Promise<void> {
  try {
    const settings = await invoke<Record<string, string>>('get_settings')
    if (settings && typeof settings === 'object') {
      useSettingsStore.getState().setSettings(settings)
      console.debug('settings:hydrated', Object.keys(settings).length, 'keys')
    }
  } catch (error) {
    console.error('failed to hydrate settings', error)
  }
}

/**
 * Subscribe to `settings:changed` Tauri event and update store on receive.
 * Call once in `App.tsx` alongside other event hooks.
 */
export function useSettingsEvents() {
  useTauriEvent<Record<string, string>>('settings:changed', ({ payload }) => {
    console.debug('event received:', 'settings:changed', payload)
    useSettingsStore.getState().setSettings(payload)
  })
}
