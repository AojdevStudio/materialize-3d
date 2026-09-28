import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

export type SidebarItem = 'library' | 'browser' | 'design' | 'monitor' | 'queue' | 'history'
export type WorkspaceView = 'library' | 'preview' | 'browser' | 'scad' | 'monitor' | 'queue' | 'history'

export interface UiState {
  sidebarItem: SidebarItem
  chatOpen: boolean
  setSidebarItem: (sidebarItem: SidebarItem) => void
  setChatOpen: (chatOpen: boolean) => void
}

export const UI_DEFAULT_STATE = {
  sidebarItem: 'library' as SidebarItem,
  chatOpen: true,
}

export function mapActiveViewToSidebarItem(activeView: WorkspaceView): SidebarItem {
  if (activeView === 'library') return 'library'
  if (activeView === 'browser') return 'browser'
  if (activeView === 'scad') return 'design'
  if (activeView === 'monitor') return 'monitor'
  if (activeView === 'queue') return 'queue'
  if (activeView === 'history') return 'history'
  return 'library'
}

export function mapSidebarItemToActiveView(sidebarItem: SidebarItem): WorkspaceView {
  if (sidebarItem === 'library') return 'library'
  if (sidebarItem === 'browser') return 'browser'
  if (sidebarItem === 'design') return 'scad'
  if (sidebarItem === 'monitor') return 'monitor'
  if (sidebarItem === 'queue') return 'queue'
  if (sidebarItem === 'history') return 'history'
  return 'preview'
}

export const useUiStore = create<UiState>()(
  subscribeWithSelector((set) => ({
    ...UI_DEFAULT_STATE,
    setSidebarItem: (sidebarItem) => set({ sidebarItem }),
    setChatOpen: (chatOpen) => set({ chatOpen }),
  })),
)

export default useUiStore
