import { useEffect, useRef } from 'react'
import { fileUrl, is3mf } from './api'
import Markdown from './Markdown'
import { FileActions } from './RightPanel'
import Trace, { Working } from './Trace'
import type { ChatItem } from './transcript'

interface ChatViewProps {
  project: string
  items: ChatItem[]
  running: boolean
  /** When the running turn started, for how long it has worked. */
  startedMs: number | undefined
  onPreview: (rel: string) => void
  onError: (message: string) => void
}

export function ChatView({ project, items, running, startedMs, onPreview, onError }: ChatViewProps) {
  const end = useRef<HTMLDivElement>(null)
  // A new step joins its trace, so the steps count as lines too.
  const lines = items.reduce((count, item) => count + (item.kind === 'trace' ? item.lines.length : 1), 0)
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
                    {item.files.map((rel) => <li key={rel}>{rel.split('/').pop()}</li>)}
                  </ul>
                )}
                {item.text && <div className="bubble">{item.text}</div>}
              </div>
            )
          case 'text':
            return <div key={i} className="msg-agent"><Markdown text={item.text} onError={onError} /></div>
          case 'trace':
            return <Trace key={item.id} trace={item} startedMs={startedMs} onError={onError} />
          case 'files':
            return (
              <ul key={i} className="file-cards" data-testid="file-cards">
                {item.files.map((rel) => (
                  <li key={rel}>
                    <span className="file-card-name">{rel}</span>
                    <button type="button" onClick={() => onPreview(rel)}>Preview</button>
                    {is3mf(rel) && <FileActions project={project} rel={rel} onError={onError} />}
                  </li>
                ))}
              </ul>
            )
        }
      })}
      {running && !items.some((item) => item.kind === 'trace' && item.running) && <Working startedMs={startedMs} />}
      <div ref={end} />
    </div>
  )
}
