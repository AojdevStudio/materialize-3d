import { useUiStore } from '../stores/ui'
import { type ActiveView, getContextTitle } from './Sidebar'

const CONTEXT_CONTENT: Record<ActiveView, { meta: string; items: Array<{ title: string; subtitle: string }> }> = {
  library: {
    meta: 'Local models and recent imports',
    items: [
      { title: 'Headphone Wall Hook', subtitle: 'MakerWorld · 2.4 MB' },
      { title: 'Cable Clip (Parametric)', subtitle: 'OpenSCAD · 48 KB' },
      { title: 'Phone Stand v3', subtitle: 'MakerWorld · 1.1 MB' },
    ],
  },
  browser: {
    meta: 'Search and import from MakerWorld',
    items: [
      { title: 'Trending wall hooks', subtitle: 'MakerWorld feed' },
      { title: 'Saved searches', subtitle: 'Headphone hook, cable guide' },
      { title: 'Import queue', subtitle: '0 pending downloads' },
    ],
  },
  design: {
    meta: 'Parametric tools and source files',
    items: [
      { title: 'OpenSCAD scripts', subtitle: '2 editable sources' },
      { title: 'Dimension presets', subtitle: 'Wall mount, desk stand' },
      { title: 'Recent exports', subtitle: 'STL and 3MF outputs' },
    ],
  },
  signs: {
    meta: 'Generated signs awaiting review',
    items: [{ title: 'Approval', subtitle: 'Only a person approves a revision for printing' }],
  },
  monitor: {
    meta: 'Live printer status and telemetry',
    items: [
      { title: 'Camera feed', subtitle: 'Unavailable until printer connects' },
      { title: 'Temperatures', subtitle: 'Nozzle · Bed · Chamber' },
      { title: 'Print progress', subtitle: 'Queue and ETA placeholder' },
    ],
  },
  history: {
    meta: 'Completed and failed prints',
    items: [{ title: 'Print history', subtitle: 'Recorded when prints finish' }],
  },
  queue: {
    meta: 'Upcoming jobs and schedule',
    items: [
      { title: 'Queued prints', subtitle: 'No jobs queued' },
      { title: 'Completed history', subtitle: 'Awaiting backend sync' },
      { title: 'Automation', subtitle: 'Batch send placeholder' },
    ],
  },
}

export function ContextPanel() {
  const activeView = useUiStore((state) => state.sidebarItem)
  const title = getContextTitle(activeView)
  const content = CONTEXT_CONTENT[activeView]

  return (
    <aside className="context-panel" aria-label={`${title} context`}>
      <div className="context-header">
        <h2 className="context-title">{title}</h2>
      </div>

      <input
        className="context-search"
        type="text"
        placeholder={`Search ${title.toLowerCase()}...`}
        aria-label={`${title} search`}
      />

      <div className="context-body">
        <section className="context-card">
          <div className="context-meta">{content.meta}</div>
          <div className="context-list">
            {content.items.map((item) => (
              <div className="context-list-item" key={item.title}>
                <div className="context-list-title">{item.title}</div>
                <div className="context-list-subtitle">{item.subtitle}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  )
}

export default ContextPanel
