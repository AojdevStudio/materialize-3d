import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Project, ProjectStatus } from '../../sidecar/src/protocol'
import { fileUrl, onSidecarEvent, sidecar, studio, type ProjectFile } from './api'
import { detail, groupOf, lastActivity } from './sidebarGroups'

/** The suggestions under the prompt box. A click puts one in the box. */
const SUGGESTIONS = ['A mount or bracket', 'A replacement part', 'A desk organizer', 'Something from a photo']

/** How many recent projects the start screen offers. */
const RECENT = 3

/** The newest render in a project's folder: a PNG the agent made, not one of the person's own pictures in `refs/`. */
function newestRender(files: ProjectFile[]): ProjectFile | undefined {
  return files.filter((f) => !f.rel.startsWith('refs/') && f.rel.toLowerCase().endsWith('.png')).sort((a, b) => b.modifiedMs - a.modifiedMs)[0]
}

type Props = {
  projects: Project[]
  /** The prompt box, with Attach, the model picker, and Start. */
  composer: ReactNode
  onSuggest: (text: string) => void
  onOpen: (project: Project) => void
  onError: (message: string) => void
}

/** The start screen: the question, the prompt box, suggestions, and the projects to pick up where the person left off. */
export default function Start({ projects, composer, onSuggest, onOpen, onError }: Props) {
  const [status, setStatus] = useState<Record<string, ProjectStatus>>({})
  const [renders, setRenders] = useState<Record<string, ProjectFile | undefined>>({})
  /** The status on screen, for the event listener to compare a chat change with. */
  const shown = useRef(status)
  shown.current = status
  /** Counts status reads, so only the newest read's answer lands. */
  const reads = useRef(0)

  const refresh = useCallback(() => {
    const read = ++reads.current
    void sidecar('projects.status', {})
      .then((found) => read === reads.current && setStatus(found))
      .catch((err: unknown) => onError(String(err)))
  }, [onError])

  useEffect(refresh, [projects, refresh])

  // As in the sidebar, a turn that starts or ends changes a project's status, and an engine that started again may
  // hold a newer one.
  useEffect(() => {
    const unlisten = onSidecarEvent((event) => {
      if (event.type === 'ready' || (event.type === 'chat' && shown.current[event.project]?.running !== event.running)) refresh()
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [refresh])

  const recent = [...projects].sort((a, b) => lastActivity(b, status[b.id]) - lastActivity(a, status[a.id])).slice(0, RECENT)
  const recentIds = recent.map((p) => p.id).join('\n')
  /** When each recent project last changed, as the status read says. A file a turn writes moves it on. */
  const recentActivity = recent.map((p) => lastActivity(p, status[p.id])).join('\n')

  // Each recent project's newest render, read again when the recent projects change, or when a status read shows one
  // changed, as when its turn ended after it wrote a render. Only the newest read lands.
  useEffect(() => {
    const ids = recentIds === '' ? [] : recentIds.split('\n')
    let live = true
    void Promise.all(ids.map(async (id) => [id, newestRender(await studio.files(id))] as const))
      .then((found) => live && setRenders(Object.fromEntries(found)))
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
            const render = renders[p.id]
            const line = detail(groupOf(status[p.id]), status[p.id])
            return (
              <button type="button" key={p.id} className="recent-chip" onClick={() => onOpen(p)} data-testid={`recent-${p.id}`}>
                {render !== undefined && <img src={fileUrl(p.id, render.rel, render.modifiedMs)} alt="" />}
                <span className="recent-text">
                  <span className="recent-title">{p.title}</span>
                  {line !== undefined && <span className="recent-detail">{line}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
