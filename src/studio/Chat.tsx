import { useEffect, useRef } from 'react'
import { modelName } from '../../sidecar/src/offered'
import { fileUrl } from './api'
import { fileName } from './files'
import Markdown from './Markdown'
import { Mark } from './marks'
import Trace, { Handoff, Working } from './Trace'
import type { ChatItem } from './transcript'

interface ChatViewProps {
  project: string
  items: ChatItem[]
  running: boolean
  /** When the running turn started, for how long it has worked. */
  startedMs: number | undefined
  onError: (message: string) => void
}

export function ChatView({ project, items, running, startedMs, onError }: ChatViewProps) {
  const end = useRef<HTMLDivElement>(null)
  // A new step joins its trace, and a helper's step its handoff, so the steps count as lines too.
  const lines = items.reduce(
    (count, item) => count + (item.kind === 'trace' ? item.lines.length : item.kind === 'handoff' ? 1 + (item.progress?.steps ?? 0) : 1),
    0,
  )
  // A running trace or handoff says the turn works, so the separate line would say it twice.
  const shownWorking = items.some((item) => (item.kind === 'trace' && item.running) || (item.kind === 'handoff' && item.state === 'running'))
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [lines, running])
  return (
    <div className="messages" data-testid="messages">
      {items.map((item, i) => {
        switch (item.kind) {
          case 'user':
            return (
              <div key={i} className="msg-user">
                {item.images.length > 0 && (
                  <div className="msg-images">
                    {item.images.map((rel) => <img key={rel} src={fileUrl(project, rel)} alt={rel} />)}
                  </div>
                )}
                {item.files.length > 0 && (
                  <ul className="msg-files">
                    {item.files.map((rel) => <li key={rel}>{fileName(rel)}</li>)}
                  </ul>
                )}
                {item.text && <div className="bubble">{item.text}</div>}
              </div>
            )
          case 'byline':
            return (
              <div key={i} className="msg-byline" data-testid="byline">
                <Mark modelId={item.model.modelId} />
                {modelName(item.model)}
              </div>
            )
          case 'text':
            return <div key={i} className="msg-agent"><Markdown text={item.text} onError={onError} /></div>
          case 'trace':
            return <Trace key={item.id} trace={item} startedMs={startedMs} onError={onError} />
          case 'handoff':
            // A provider can reuse a call id in a later turn, so the place in the chat keeps two such entries apart.
            return <Handoff key={`${i}:${item.id}`} handoff={item} />
        }
      })}
      {running && !shownWorking && <Working startedMs={startedMs} />}
      <div ref={end} />
    </div>
  )
}
