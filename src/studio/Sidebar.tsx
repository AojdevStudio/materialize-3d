import { useEffect, useMemo, useRef, useState } from 'react'
import type { Printer, Project } from '../../sidecar/src/protocol'
import { BrandRow, Icon, WorkingRing } from './marks'
import { printerModel } from './presetNames'
import { ago, detail, type Group, groupProjects, lastActivity } from './sidebarGroups'
import { markPrinted, useStudio } from './store'
import { useTheme } from './theme'
import { useDismiss } from './useDismiss'
import bambuMark from '../assets/icons/bambulab.svg?raw'
import blocks from '../assets/icons/module-three.svg?raw'
import layers from '../assets/icons/layers-stacked.svg?raw'
import layoutLeft from '../assets/icons/layout-left.svg?raw'
import loading from '../assets/icons/loading-half.svg?raw'
import star from '../assets/icons/rating-star.svg?raw'
import gear from '../assets/icons/settings.svg?raw'

const HEADERS: Record<Group, { name: string; icon: string }> = {
  working: { name: 'Working', icon: loading },
  ready: { name: 'Ready to print', icon: layers },
  printed: { name: 'Printed', icon: star },
  drafts: { name: 'Drafts', icon: blocks },
}

/** A row's status mark: a blue ring while working, a green check when ready, a gray check when printed. */
function StatusMark({ group }: { group: Group }) {
  if (group === 'working') return <WorkingRing className="mark working" size={14} />
  if (group === 'drafts') {
    return (
      <svg className="mark draft" viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
        <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeWidth={1.5} />
      </svg>
    )
  }
  return (
    <svg className={`mark ${group}`} viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
      <circle cx={8} cy={8} r={7} fill="currentColor" />
      <path d="M5 8.2l2 2 4-4.2" fill="none" stroke="var(--s-raised)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The sidebar's theme toggle: a sun in light, a moon in dark. */
function ThemeToggle() {
  const dark = useTheme((s) => s.theme === 'dark')
  const toggle = useTheme((s) => s.toggle)
  return (
    <button type="button" className="icon-button" aria-label="Dark mode" aria-pressed={dark} onClick={toggle} data-testid="theme-toggle">
      <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {dark ? (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
        ) : (
          <>
            <circle cx={12} cy={12} r={4} />
            <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        )}
      </svg>
    </button>
  )
}

type Props = {
  projects: Project[]
  current: string | null
  engine: string
  /** The printer the next slice runs for. Null until the saved state is read. */
  printer: Printer | null
  onOpen: (project: Project) => void
  onNew: () => void
  onSettings: () => void
}

/** The projects sidebar: projects grouped by status, newest first in each group, with the time of their last activity. */
export default function Sidebar({ projects, current, engine, printer, onOpen, onNew, onSettings }: Props) {
  const status = useStudio((s) => s.status)
  const [now, setNow] = useState(() => Date.now())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  /** The search field's text while it is open. Null when it is closed. */
  const [search, setSearch] = useState<string | null>(null)
  const menu = useRef<HTMLLIElement>(null)
  const searchButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useDismiss(menuFor !== null, menu, () => setMenuFor(null))

  const query = search?.trim().toLowerCase() ?? ''
  const groups = useMemo(
    () => groupProjects(query === '' ? projects : projects.filter((p) => p.title.toLowerCase().includes(query)), status),
    [projects, status, query],
  )

  const panelToggle = (
    <button
      type="button"
      className="icon-button"
      aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-expanded={!collapsed}
      onClick={() => setCollapsed(!collapsed)}
      data-testid="sidebar-toggle"
    >
      <Icon className="side-icon" svg={layoutLeft} />
    </button>
  )

  if (collapsed) {
    return (
      <nav className="sessions collapsed" aria-label="Projects">
        {panelToggle}
      </nav>
    )
  }

  return (
    <nav className="sessions" aria-label="Projects">
      <BrandRow>{panelToggle}</BrandRow>
      <div className="side-actions">
        <button type="button" className="new-project primary" onClick={onNew} data-testid="new-project">
          <span aria-hidden="true">+</span>
          New project
        </button>
        <button
          type="button"
          ref={searchButton}
          className="search-button"
          aria-label="Search projects"
          aria-expanded={search !== null}
          onClick={() => setSearch(search === null ? '' : null)}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
            <circle cx={11} cy={11} r={6.5} />
            <path d="M16 16l4.5 4.5" />
          </svg>
        </button>
      </div>
      {search !== null && (
        <input
          type="search"
          className="side-search"
          aria-label="Search projects"
          placeholder="Search projects"
          value={search}
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            setSearch(null)
            searchButton.current?.focus()
          }}
        />
      )}
      <div className="groups">
        <h2 className="group-header" data-testid="projects-row">
          <Icon className="side-icon" svg={blocks} />
          <span className="group-name">Projects</span>
          <span className="group-count">{projects.length}</span>
        </h2>
        {query !== '' && groups.length === 0 && <p className="no-match">No projects match.</p>}
        {groups.map(({ group, projects: rows }) => (
          <section key={group} className="group" data-testid={`group-${group}`} aria-label={HEADERS[group].name}>
            <h2 className="group-header">
              <Icon className="side-icon" svg={HEADERS[group].icon} />
              <span className="group-name">{HEADERS[group].name}</span>
              <span className="group-count">{rows.length}</span>
            </h2>
            <ul>
              {rows.map((p) => {
                const line = detail(group, status[p.id])
                return (
                  <li key={p.id} className="project-row" data-testid={`project-${p.id}`} ref={menuFor === p.id ? menu : undefined}>
                    <button type="button" className="row-open" aria-current={p.id === current} onClick={() => onOpen(p)} title={p.title}>
                      <StatusMark group={group} />
                      <span className="row-text">
                        <span className="row-title">{p.title}</span>
                        {line !== undefined && <span className="row-detail">{line}</span>}
                      </span>
                      <span className="row-time">{ago(lastActivity(p, status[p.id]), now)}</span>
                    </button>
                    {status[p.id]?.printed !== true && (
                      <button
                        type="button"
                        className="row-menu-button"
                        aria-label={`${p.title} menu`}
                        aria-haspopup="menu"
                        aria-expanded={menuFor === p.id}
                        onClick={() => setMenuFor(menuFor === p.id ? null : p.id)}
                      >
                        <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" aria-hidden="true">
                          <circle cx={3} cy={8} r={1.3} />
                          <circle cx={8} cy={8} r={1.3} />
                          <circle cx={13} cy={8} r={1.3} />
                        </svg>
                      </button>
                    )}
                    {menuFor === p.id && (
                      <div className="row-menu" role="menu" ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
                        <button type="button" role="menuitem" onClick={() => {
                            setMenuFor(null)
                            markPrinted(p.id)
                          }}
                        >
                          Mark as printed
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      <footer className="sessions-footer">
        <button type="button" className="icon-button" aria-label="Settings" onClick={onSettings} data-testid="settings-open">
          <Icon className="side-icon" svg={gear} />
        </button>
        <ThemeToggle />
        <p className="engine" data-testid="engine" title={engine}>
          {engine}
        </p>
        {printer !== null && (
          <p className="printer" data-testid="printer" title={printer.machine}>
            <Icon className="side-icon" svg={bambuMark} />
            <span className="printer-name">{printerModel(printer.machine)}</span>
          </p>
        )}
      </footer>
    </nav>
  )
}
