import { create } from 'zustand'
import { updater, type UpdateCheck, type UpdateProgress } from '../studio/api'
import { useTauriEvent } from './useTauriEvent'

type AvailableUpdate = Extract<UpdateCheck, { status: 'available' }>

/**
 * idle: no check yet. checking: a check is running. upToDate and available: the
 * last check's answer. installing: Update now was clicked; the app restarts when
 * it succeeds. error: the last check or install failed and the app runs on.
 */
type UpdatePhase = 'idle' | 'checking' | 'upToDate' | 'available' | 'installing' | 'error'

interface UpdateState {
  phase: UpdatePhase
  available: AvailableUpdate | null
  error: string | null
  failed: 'check' | 'install' | null
  progress: UpdateProgress | null
  /** Running builds the downloaded update waits for before it installs. 0 when it is not waiting. */
  waitingFor: number
  /** Later hides the banner for this launch only. The next launch asks again. */
  dismissed: boolean
}

const UPDATE_DEFAULT_STATE: UpdateState = {
  phase: 'idle',
  available: null,
  error: null,
  failed: null,
  progress: null,
  waitingFor: 0,
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
      const check = await updater.check()
      useUpdateStore.setState(
        check.status === 'available'
          ? { phase: 'available', available: check }
          : { phase: 'upToDate', available: null },
      )
    } catch (error) {
      useUpdateStore.setState({ phase: 'error', error: String(error), failed: 'check' })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function checkForUpdatesAtLaunch(): Promise<void> {
  if (checkedAtLaunch) return Promise.resolve()
  checkedAtLaunch = true
  return checkForUpdates()
}

export function waitingMessage(builds: number): string {
  return `Waiting for ${builds === 1 ? '1 build' : `${builds} builds`} to finish. Then the update installs and the app restarts.`
}

export function dismissUpdate(): void {
  useUpdateStore.setState({ dismissed: true })
}

/** Update now. On success the backend restarts the app, so this only returns on failure. */
export async function installUpdate(): Promise<void> {
  const { available, phase } = useUpdateStore.getState()
  if (!available || phase === 'installing') return
  useUpdateStore.setState({ phase: 'installing', error: null, progress: null, waitingFor: 0, dismissed: false })
  try {
    await updater.install(available.version)
  } catch (error) {
    useUpdateStore.setState({ phase: 'error', error: String(error), failed: 'install', progress: null, waitingFor: 0 })
  }
}

export function useUpdateEvents() {
  useTauriEvent('update:progress', (progress) => {
    useUpdateStore.setState({ progress })
  })
  useTauriEvent('update:waiting', (waitingFor) => {
    useUpdateStore.setState({ waitingFor })
  })
}
