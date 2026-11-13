import { useEffect, useState, type ReactNode } from 'react'
import type { Project, ProjectStatus } from '../../sidecar/src/protocol'
import { fileUrl, panelFiles, studio, type ProjectFile } from './api'
import { groupOf, lastActivity, type Group } from './sidebarGroups'

/** The suggestions under the prompt box. A click puts one in the box. */
const SUGGESTIONS = ['A mount or bracket', 'A replacement part', 'A desk organizer', 'Something from a photo']

/** How many recent projects the start screen offers: as many as fit on one row beside the label. */
const RECENT = 2

/** A recent project's state under its title, by its sidebar group. A draft with a guide says so instead. */
const STATE: Record<Group, string> = { working: 'working', ready: '3MF ready', printed: 'printed', drafts: 'draft' }

/** What a recent project's folder shows: its newest render, and whether it has a guide. */
type Folder = { render: ProjectFile | undefined; guide: boolean }

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
  const [folders, setFolders] = useState<Partial<Record<string, Folder>>>({})

  const recent = [...projects].sort((a, b) => lastActivity(b, status[b.id]) - lastActivity(a, status[a.id])).slice(0, RECENT)
  const recentIds = recent.map((p) => p.id).join('\n')
  /** When each recent project last changed, as the status read says. A file a turn writes moves it on. */
  const recentActivity = recent.map((p) => lastActivity(p, status[p.id])).join('\n')

  // Each recent project's folder, read again when the recent projects change, or when a status read shows one changed,
  // as when its turn ended after it wrote a render or a guide. Only the newest read lands.
  useEffect(() => {
    const ids = recentIds === '' ? [] : recentIds.split('\n')
    let live = true
    void Promise.all(
      ids.map(async (id) => {
        const files = await studio.files(id)
        return [id, { render: newestRender(files), guide: panelFiles(files).guide !== undefined }] as const
      }),
    )
      .then((found) => live && setFolders(Object.fromEntries(found)))
      .catch((err: unknown) => live && onError(String(err)))
    return () => {
      live = false
    }
  }, [recentIds, recentActivity, onError])

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
            const folder = folders[p.id]
            const group = groupOf(status[p.id])
            return (
              <button type="button" key={p.id} className="recent-chip" onClick={() => onOpen(p)} data-testid={`recent-${p.id}`}>
                {folder?.render !== undefined && <img src={fileUrl(p.id, folder.render.rel, folder.render.modifiedMs)} alt="" />}
                <span className="recent-text">
                  <span className="recent-title">{p.title}</span>
                  {status[p.id] !== undefined && folder !== undefined && (
                    <span className="recent-detail">{group === 'drafts' && folder.guide ? 'guide ready' : STATE[group]}</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
