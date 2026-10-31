import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import useTauriEvent from '../hooks/useTauriEvent'

/** What `update_check` returns. Mirrors `UpdateCheck` in `src-tauri/src/updater.rs`. */
export type UpdateCheck =
  | { status: 'upToDate'; currentVersion: string }
  | { status: 'available'; currentVersion: string; version: string; notes: string | null; date: string | null }

export type AvailableUpdate = Extract<UpdateCheck, { status: 'available' }>

export interface UpdateProgress {
  downloaded: number
  total: number | null
}

/**
 * idle: no check yet. checking: a check is running. upToDate and available: the
 * last check's answer. installing: Update now was clicked; the app restarts when
 * it succeeds. error: the last check or install failed and the app runs on.
 */
export type UpdatePhase = 'idle' | 'checking' | 'upToDate' | 'available' | 'installing' | 'error'

interface UpdateState {
  phase: UpdatePhase
  available: AvailableUpdate | null
  error: string | null
  progress: UpdateProgress | null
  /** Later hides the banner for this launch only. The next launch asks again. */
  dismissed: boolean
}

export const UPDATE_DEFAULT_STATE: UpdateState = {
  phase: 'idle',
  available: null,
  error: null,
  progress: null,
  dismissed: false,
}

export const useUpdateStore = create<UpdateState>()(() => ({ ...UPDATE_DEFAULT_STATE }))

let inFlight: Promise<void> | null = null
let checkedAtLaunch = false

/** Asks the backend for a newer release. Concurrent calls share one check. */
export function checkForUpdates(): Promise<void> {
  if (useUpdateStore.getState().phase === 'installing') return Promise.resolve()
  inFlight ??= (async () => {
    useUpdateStore.setState({ phase: 'checking', error: null })
    try {
      const check = await invoke<UpdateCheck>('update_check')
      useUpdateStore.setState(
        check.status === 'available'
          ? { phase: 'available', available: check }
          : { phase: 'upToDate', available: null },
      )
    } catch (error) {
      useUpdateStore.setState({ phase: 'error', error: String(error) })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** The one check each launch makes. */
export function checkForUpdatesAtLaunch(): Promise<void> {
  if (checkedAtLaunch) return Promise.resolve()
  checkedAtLaunch = true
  return checkForUpdates()
}

export function dismissUpdate(): void {
  useUpdateStore.setState({ dismissed: true })
}

/** Update now. On success the backend restarts the app, so this only returns on failure. */
export async function installUpdate(): Promise<void> {
  const { available, phase } = useUpdateStore.getState()
  if (!available || phase === 'installing') return
  useUpdateStore.setState({ phase: 'installing', error: null, progress: null, dismissed: false })
  try {
    await invoke('update_install', { version: available.version })
  } catch (error) {
    useUpdateStore.setState({ phase: 'error', error: String(error), progress: null })
  }
}

export function useUpdateEvents() {
  useTauriEvent<UpdateProgress>('update:progress', ({ payload }) => {
    useUpdateStore.setState({ progress: payload })
  })
}

/** Test seam: forget this launch's check. */
export function resetUpdateStoreForTests(): void {
  inFlight = null
  checkedAtLaunch = false
  useUpdateStore.setState({ ...UPDATE_DEFAULT_STATE })
}
