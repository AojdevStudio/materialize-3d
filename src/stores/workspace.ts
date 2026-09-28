import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import useTauriEvent from '../hooks/useTauriEvent'
import { mapActiveViewToSidebarItem, type WorkspaceView, useUiStore } from './ui'

export const MAKERWORLD_HOME_URL = 'https://makerworld.com/en'

export interface ModelInfo {
  id: string | null
  name: string
  path: string | null
  source: string | null
  sizeBytes: number | null
}

export type MakerWorldPageKind = 'home' | 'search' | 'model' | 'other'
export type ModelImportStatus = 'idle' | 'ready' | 'downloading' | 'imported' | 'error'

export interface MakerWorldFile {
  name: string
  fileType: string | null
  downloadUrl: string | null
}

export interface MakerWorldModel {
  id: string | null
  title: string
  author: string | null
  sourceUrl: string
  rating: number | null
  reviewCount: number | null
  downloadCount: number | null
  images: string[]
  files: MakerWorldFile[]
}

export interface MakerWorldSnapshot {
  currentUrl: string
  pageKind: MakerWorldPageKind
  detectedModel: MakerWorldModel | null
  importStatus: ModelImportStatus
  importedFiles: string[]
  lastExtractionError: string | null
}

export interface WorkspaceSnapshot {
  activeModel: ModelInfo | null
  activeView: WorkspaceView
  makerworld: MakerWorldSnapshot
}

interface WorkspaceState extends WorkspaceSnapshot {
  applySnapshot: (snapshot: WorkspaceSnapshot) => void
  setActiveView: (view: WorkspaceView) => Promise<void>
  navigateMakerWorld: (target: string) => Promise<void>
  searchMakerWorld: (query: string) => Promise<void>
  goBackMakerWorld: () => Promise<void>
  goForwardMakerWorld: () => Promise<void>
  reloadMakerWorld: () => Promise<void>
  importMakerWorldModel: () => Promise<void>
}

export const MAKERWORLD_DEFAULT_STATE: MakerWorldSnapshot = {
  currentUrl: MAKERWORLD_HOME_URL,
  pageKind: 'home',
  detectedModel: null,
  importStatus: 'idle',
  importedFiles: [],
  lastExtractionError: null,
}

export const WORKSPACE_DEFAULT_STATE: WorkspaceSnapshot = {
  activeModel: null,
  activeView: 'preview',
  makerworld: MAKERWORLD_DEFAULT_STATE,
}

export const useWorkspaceStore = create<WorkspaceState>()(
  subscribeWithSelector((set) => ({
    ...WORKSPACE_DEFAULT_STATE,
    applySnapshot: (snapshot) => set(snapshot),
    setActiveView: async (view) => {
      await invoke('set_active_view', { view })
    },
    navigateMakerWorld: async (target) => {
      await invoke('navigate_makerworld', { url: target })
    },
    searchMakerWorld: async (query) => {
      await invoke('search_makerworld', { query })
    },
    goBackMakerWorld: async () => {
      await invoke('makerworld_back')
    },
    goForwardMakerWorld: async () => {
      await invoke('makerworld_forward')
    },
    reloadMakerWorld: async () => {
      await invoke('makerworld_reload')
    },
    importMakerWorldModel: async () => {
      await invoke('download_model')
    },
  })),
)

export function applyWorkspaceSnapshot(snapshot: WorkspaceSnapshot) {
  useWorkspaceStore.getState().applySnapshot(snapshot)
  useUiStore.getState().setSidebarItem(mapActiveViewToSidebarItem(snapshot.activeView))
}

export function useWorkspaceEvents() {
  useTauriEvent<WorkspaceSnapshot>('workspace:changed', ({ payload }) => {
    console.debug('event received:', 'workspace:changed', payload)
    applyWorkspaceSnapshot(payload)
  })
}
