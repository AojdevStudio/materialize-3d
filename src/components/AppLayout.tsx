import ChatPanel from './ChatPanel'
import ContextPanel from './ContextPanel'
import { ErrorBoundary } from './ErrorBoundary'
import MainPanel from './MainPanel'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import Toolbar from './Toolbar'
import { useUiStore } from '../stores/ui'
import { useWorkspaceStore } from '../stores/workspace'

export function AppLayout() {
  const sidebarItem = useUiStore((state) => state.sidebarItem)
  const setActiveView = useWorkspaceStore((state) => state.setActiveView)

  return (
    <div className="app-layout">
      <Toolbar />

      <div className="main-layout">
        <Sidebar activeView={sidebarItem} onNavigate={(view) => void setActiveView(view)} />

        <div className="content-area">
          <ContextPanel />
          <ErrorBoundary>
            <MainPanel />
          </ErrorBoundary>
          <ChatPanel />
        </div>
      </div>

      <StatusBar version="v0.1.0" />
    </div>
  )
}

export default AppLayout
