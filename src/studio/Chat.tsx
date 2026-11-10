import { useEffect, useRef, type ReactNode } from 'react'
import { fileUrl, is3mf } from './api'
import { FileActions } from './RightPanel'
import type { ChatItem } from './transcript'

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return <code key={i}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>
    return part
  })
}

/** Just enough markdown for agent replies: code fences, inline code, and bold. Lists stay as typed. */
function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split(/```[^\n]*\n?/).map((chunk, i) =>
        i % 2 === 1 ? <pre key={i}>{chunk.replace(/\n$/, '')}</pre> : <p key={i}>{inline(chunk.trim())}</p>,
      )}
    </>
  )
}

function ToolLine({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const state = item.result === undefined ? 'running' : item.failed ? 'failed' : 'done'
  return (
    <details className={`tool tool-${state}`}>
      <summary>
        <span className="tool-label">{item.label}</span> <span className="tool-summary">{item.summary}</span>
        {state === 'failed' && <span className="tool-flag">failed</span>}
      </summary>
      <pre>{item.detail}</pre>
      {item.result !== undefined && <pre className="tool-result">{item.result.slice(0, 4000)}</pre>}
    </details>
  )
}

interface ChatViewProps {
  project: string
  items: ChatItem[]
  running: boolean
  onPreview: (rel: string) => void
  onError: (message: string) => void
}

export function ChatView({ project, items, running, onPreview, onError }: ChatViewProps) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items.length, running])
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
            return <div key={i} className="msg-agent"><Markdown text={item.text} /></div>
          case 'tool':
            return <ToolLine key={item.id} item={item} />
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
      {running && <p className="working" data-testid="working">Working…</p>}
      <div ref={end} />
    </div>
  )
}
