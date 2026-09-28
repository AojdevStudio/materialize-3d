import { mapSidebarItemToActiveView, type SidebarItem } from '../stores/ui'

export type ActiveView = SidebarItem

export interface NavItem {
  key: ActiveView
  label: string
  icon: string
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'library', label: 'Library', icon: '📁' },
  { key: 'browser', label: 'MakerWorld', icon: '🌐' },
  { key: 'design', label: 'Design', icon: '✏' },
  { key: 'signs', label: 'Signs', icon: '🪧' },
  { key: 'monitor', label: 'Print Monitor', icon: '🖨' },
  { key: 'queue', label: 'Print Queue', icon: '📋' },
  { key: 'history', label: 'History', icon: '📜' },
]

const CONTEXT_TITLES: Record<ActiveView, string> = {
  library: 'Library',
  browser: 'MakerWorld',
  design: 'Design',
  signs: 'Signs',
  monitor: 'Print Monitor',
  queue: 'Print Queue',
  history: 'Print History',
}

export function getContextTitle(view: ActiveView) {
  return CONTEXT_TITLES[view]
}

interface SidebarProps {
  activeView: ActiveView
  onNavigate: (view: ReturnType<typeof mapSidebarItemToActiveView>) => void
}

export function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Primary">
      {NAV_ITEMS.slice(0, 5).map((item) => (
        <button
          key={item.key}
          type="button"
          className={`sidebar-btn${item.key === activeView ? ' active' : ''}`}
          onClick={() => onNavigate(mapSidebarItemToActiveView(item.key))}
          aria-current={item.key === activeView ? 'page' : undefined}
          aria-label={item.label}
          title={item.label}
        >
          <span className="sidebar-btn-icon" aria-hidden="true">{item.icon}</span>
          <span className="sidebar-btn-label">{item.label}</span>
        </button>
      ))}

      <div className="sidebar-spacer" />

      {NAV_ITEMS.slice(5).map((item) => (
        <button
          key={item.key}
          type="button"
          className={`sidebar-btn${item.key === activeView ? ' active' : ''}`}
          onClick={() => onNavigate(mapSidebarItemToActiveView(item.key))}
          aria-current={item.key === activeView ? 'page' : undefined}
          aria-label={item.label}
          title={item.label}
        >
          <span className="sidebar-btn-icon" aria-hidden="true">{item.icon}</span>
          <span className="sidebar-btn-label">{item.label}</span>
        </button>
      ))}
    </nav>
  )
}

export default Sidebar
