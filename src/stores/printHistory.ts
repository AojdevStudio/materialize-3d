import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface PrintHistoryRecord {
  id: string
  modelName: string
  gcodeFile: string | null
  startedAt: string | null
  completedAt: string
  durationSeconds: number | null
  status: string
  failReason: string | null
  filamentGrams: number | null
  filamentMeters: number | null
  thumbnailPath: string | null
  qualityProfile: string | null
}

interface PrintHistoryState {
  records: PrintHistoryRecord[]
  loadError: string | null
  applySnapshot: (records: PrintHistoryRecord[]) => void
}

export const HISTORY_DEFAULT_STATE: Pick<PrintHistoryState, 'records' | 'loadError'> = {
  records: [],
  loadError: null,
}

export const usePrintHistoryStore = create<PrintHistoryState>()(
  subscribeWithSelector((set) => ({
    ...HISTORY_DEFAULT_STATE,
    applySnapshot: (records) => set({ records, loadError: null }),
  })),
)

export function applyHistorySnapshot(records: PrintHistoryRecord[]) {
  usePrintHistoryStore.getState().applySnapshot(records)
}

export function usePrintHistoryEvents() {
  useEffect(() => {
    let disposed = false
    let receivedEvent = false
    let unlisten: UnlistenFn | null = null

    const load = async () => {
      try {
        const teardown = await listen<PrintHistoryRecord[]>('history:changed', ({ payload }) => {
          if (disposed) return
          receivedEvent = true
          applyHistorySnapshot(payload)
        })
        if (disposed) {
          teardown()
          return
        }
        unlisten = teardown

        const records = await invoke<PrintHistoryRecord[]>('get_print_history')
        // A full event snapshot supersedes the initial read, including deleted rows.
        if (!disposed && !receivedEvent) applyHistorySnapshot(records)
      } catch (error) {
        if (!disposed && !receivedEvent) {
          usePrintHistoryStore.setState({ loadError: error instanceof Error ? error.message : String(error) })
        }
      }
    }

    void load()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
