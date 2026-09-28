import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import useTauriEvent from '../hooks/useTauriEvent'

export interface LibraryModel {
  id: string
  modelName: string
  author: string | null
  sourceUrl: string | null
  importedAt: string
  thumbnailUrl: string | null
  filePath: string | null
  folderPath: string
  rating: number | null
  downloadCount: number | null
  fileCount: number | null
}

interface LibraryState {
  models: LibraryModel[]
  applySnapshot: (models: LibraryModel[]) => void
}

export const LIBRARY_DEFAULT_STATE = {
  models: [] as LibraryModel[],
}

export const useLibraryStore = create<LibraryState>()(
  subscribeWithSelector((set) => ({
    ...LIBRARY_DEFAULT_STATE,
    applySnapshot: (models) => set({ models }),
  })),
)

export function applyLibrarySnapshot(models: LibraryModel[]) {
  useLibraryStore.getState().applySnapshot(models)
}

export function useLibraryEvents() {
  useTauriEvent<LibraryModel[]>('library:changed', ({ payload }) => {
    console.debug('event received:', 'library:changed', payload)
    applyLibrarySnapshot(payload)
  })
}
