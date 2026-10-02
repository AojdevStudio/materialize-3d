import { lazy, Suspense, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import MakerWorldBrowser from './MakerWorldBrowser'
import { ModelViewer } from './ModelViewer'
import { PrintMonitor } from './PrintMonitor'
import { PrintHistory } from './PrintHistory'
import { ModelLibrary } from './ModelLibrary'
import { DesignsView } from './designs/DesignsView'
import { useWorkspaceStore } from '../stores/workspace'
import type { WorkspaceView } from '../stores/ui'

const DesignTab = lazy(() => import('./DesignTab'))

export type MainTabKey = 'library' | 'preview' | 'signs' | 'browser' | 'scad' | 'monitor' | 'history'

export interface MainTab {
  key: MainTabKey
  label: string
}

export const MAIN_TABS: MainTab[] = [
  { key: 'library', label: 'Model Library' },
  { key: 'preview', label: '3D Preview' },
  { key: 'signs', label: 'Signs' },
  { key: 'browser', label: 'MakerWorld' },
  { key: 'scad', label: 'OpenSCAD' },
  { key: 'monitor', label: 'Print Monitor' },
  { key: 'history', label: 'Print History' },
]

export function getDefaultTabForView(view: WorkspaceView): MainTabKey {
  if (view === 'library') return 'library'
  if (view === 'browser') return 'browser'
  if (view === 'scad') return 'scad'
  if (view === 'signs') return 'signs'
  if (view === 'monitor') return 'monitor'
  if (view === 'history') return 'history'
  return 'preview'
}

export function MainPanel() {
  const activeView = useWorkspaceStore((state) => state.activeView)
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)
  const activeTab = getDefaultTabForView(activeView)

  // Explicitly hide the native MakerWorld webview when switching away from the browser tab.
  // The WKWebView is a native overlay that persists independently of React rendering —
  // CSS display:none has no effect on it. We must call sync_makerworld_webview with
  // visible:false to hide it at the OS level.
  useEffect(() => {
    if (activeTab !== 'browser') {
      invoke('sync_makerworld_webview', {
        bounds: { x: 0, y: 0, width: 1, height: 1, visible: false },
      }).catch((err) => {
        // Ignore errors — webview may not exist yet if browser tab was never visited
        console.debug('makerworld:hide-on-tab-switch', err)
      })
    }
  }, [activeTab])

  const isFullBleed = activeTab === 'browser' || activeTab === 'preview' || activeTab === 'library' || activeTab === 'scad' || activeTab === 'signs'

  return (
    <section className="main-panel" aria-label="Workspace">
      <div className="main-panel-tabs" role="tablist" aria-label="Main workspace tabs">
        {MAIN_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === activeTab}
            className={`panel-tab${tab.key === activeTab ? ' active' : ''}`}
            onClick={() => void setActiveView(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className={`panel-content${isFullBleed ? ' panel-content-fullbleed' : ''}`}>
        {activeTab === 'library' ? (
          <ModelLibrary />
        ) : activeTab === 'preview' ? (
          <ModelViewer />
        ) : activeTab === 'browser' ? (
          <MakerWorldBrowser />
        ) : activeTab === 'scad' ? (
          <Suspense fallback={null}>
            <DesignTab />
          </Suspense>
        ) : activeTab === 'signs' ? (
          <DesignsView />
        ) : activeTab === 'monitor' ? (
          <PrintMonitor />
        ) : activeTab === 'history' ? (
          <PrintHistory />
        ) : null}
      </div>
    </section>
  )
}

export default MainPanel
