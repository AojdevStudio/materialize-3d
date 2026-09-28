import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import useTauriEvent from '../hooks/useTauriEvent'

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
  applySnapshot: (records: PrintHistoryRecord[]) => void
}

export const HISTORY_DEFAULT_STATE = {
  records: [] as PrintHistoryRecord[],
}

export const usePrintHistoryStore = create<PrintHistoryState>()(
  subscribeWithSelector((set) => ({
    ...HISTORY_DEFAULT_STATE,
    applySnapshot: (records) => set({ records }),
  })),
)

export function applyHistorySnapshot(records: PrintHistoryRecord[]) {
  usePrintHistoryStore.getState().applySnapshot(records)
}

export function usePrintHistoryEvents() {
  useTauriEvent<PrintHistoryRecord[]>('history:changed', ({ payload }) => {
    console.debug('event received:', 'history:changed', payload)
    applyHistorySnapshot(payload)
  })
}
