import { useEffect, useState, type ReactNode } from 'react'
import type { Project, ProjectStatus } from '../../sidecar/src/protocol'
import { fileUrl, panelFiles, studio, type ProjectFile } from './api'
import { groupOf, lastActivity, type Group } from './sidebarGroups'

/** The suggestions under the prompt box. A click puts one in the box. */
const SUGGESTIONS = ['A mount or bracket', 'A replacement part', 'A desk organizer', 'Something from a photo']

/** How many recent projects the start screen offers: as many as fit on one row beside the label. */
const RECENT = 2

/** A recent project's state under its title, by its sidebar group. */
const STATE: Record<Group, string> = { working: 'working', ready: '3MF ready', printed: 'printed', drafts: 'draft' }

/** What a recent chip shows once its folder is read: its newest render, and its state, none while its status has not come. */
type Chip = { render: ProjectFile | undefined; line: string | undefined }

/** The newest render in a project's folder: a PNG the agent made, not one of the person's own pictures in `refs/`. */
function newestRender(files: ProjectFile[]): ProjectFile | undefined {
  return files.filter((f) => !f.rel.startsWith('refs/') && f.rel.toLowerCase().endsWith('.png')).sort((a, b) => b.modifiedMs - a.modifiedMs)[0]
}

type Props = {
  projects: Project[]
  /** Each project's status, as the sidebar keeps it. */
  status: Record<string, ProjectStatus>
  /** The prompt box, with Attach, the model picker, and Start. */
  composer: ReactNode
  onSuggest: (text: string) => void
  onOpen: (project: Project) => void
  onError: (message: string) => void
}

/** The start screen: the question, the prompt box, suggestions, and the projects to pick up where the person left off. */
export default function Start({ projects, status, composer, onSuggest, onOpen, onError }: Props) {
  const [chips, setChips] = useState<Partial<Record<string, Chip>>>({})

  const recent = [...projects].sort((a, b) => lastActivity(b, status[b.id]) - lastActivity(a, status[a.id])).slice(0, RECENT)
  /**
   * Each recent project's id, when it last changed, and its state as its sidebar group says it, empty while its status
   * has not come. A file a turn writes moves the time on. A change to any of them reads the folder again.
   */
  const reads = recent
    .map((p) => [p.id, lastActivity(p, status[p.id]), status[p.id] === undefined ? '' : STATE[groupOf(status[p.id])]].join('\t'))
    .join('\n')

  // A chip changes only when its folder read lands, so its line never pairs a new status with an old folder, as just
  // after a turn that wrote a guide ends. Only the newest reads land. A read that fails sets its own chip's line from the
  // status and leaves the other chips.
  useEffect(() => {
    let live = true
    for (const read of reads === '' ? [] : reads.split('\n')) {
      const [id, , state] = read.split('\t')
      void studio.files(id).then(
        (files) => {
          const line = state === STATE.drafts && panelFiles(files).guide !== undefined ? 'guide ready' : state
          if (live) setChips((chips) => ({ ...chips, [id]: { render: newestRender(files), line: line === '' ? undefined : line } }))
        },
        (err: unknown) => {
          if (!live) return
          // Without the folder, the status still says the state. Only "guide ready" needs the folder.
          setChips((chips) => ({ ...chips, [id]: { render: chips[id]?.render, line: state === '' ? undefined : state } }))
          onError(String(err))
        },
      )
    }
    return () => {
      live = false
    }
  }, [reads, onError])

  return (
    <div className="start" data-testid="start-screen">
      <h1>What are we making?</h1>
      {composer}
      <div className="chips">
        {SUGGESTIONS.map((s) => (
          <button type="button" key={s} onClick={() => onSuggest(s)}>
            {s}
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <div className="recent" data-testid="recent">
          <span className="recent-label">Pick up where you left off</span>
          {recent.map((p) => {
            const chip = chips[p.id]
            return (
              <button type="button" key={p.id} className="recent-chip" onClick={() => onOpen(p)} data-testid={`recent-${p.id}`}>
                {chip?.render !== undefined && <img src={fileUrl(p.id, chip.render.rel, chip.render.modifiedMs)} alt="" />}
                <span className="recent-text">
                  <span className="recent-title">{p.title}</span>
                  {chip?.line !== undefined && <span className="recent-detail">{chip.line}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
