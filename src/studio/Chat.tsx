import { useEffect, useRef, useState, type ReactNode } from 'react'
import { pickFile } from '../lib/fileDialog'
import { fileUrl, is3mf } from './api'
import { FileActions } from './RightPanel'
import type { ChatItem } from './transcript'

/** A picture waiting to be sent: a dropped file on disk, or pasted bytes. */
export type Attachment =
  | { kind: 'path'; name: string; path: string }
  | { kind: 'bytes'; name: string; bytes: Uint8Array; previewUrl: string }

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
          case 'error':
            return <p key={i} className="msg-error">{item.text}</p>
        }
      })}
      {running && <p className="working" data-testid="working">Working…</p>}
      <div ref={end} />
    </div>
  )
}

interface ComposerProps {
  attachments: Attachment[]
  onAttach: (files: Attachment[]) => void
  onRemove: (index: number) => void
  onSend: (text: string) => void
  onStop?: () => void
  running: boolean
  placeholder: string
  draft?: string
  autoFocus?: boolean
}

export function Composer({ attachments, onAttach, onRemove, onSend, onStop, running, placeholder, draft, autoFocus }: ComposerProps) {
  const [text, setText] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (draft !== undefined) {
      setText(draft)
      input.current?.focus()
    }
  }, [draft])

  const submit = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || running) return
    onSend(trimmed)
    setText('')
  }

  const paste = async (event: React.ClipboardEvent) => {
    const pictures = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (pictures.length === 0) return
    event.preventDefault()
    onAttach(
      await Promise.all(
        pictures.map(async (file, i) => ({
          kind: 'bytes' as const,
          name: file.name && file.name !== 'image.png' ? file.name : `pasted-${Date.now()}-${i}.${file.type.split('/')[1] ?? 'png'}`,
          bytes: new Uint8Array(await file.arrayBuffer()),
          previewUrl: URL.createObjectURL(file),
        })),
      ),
    )
  }

  const pick = async () => {
    const path = await pickFile({ filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] }] })
    if (path) onAttach([{ kind: 'path', name: path.split(/[\\/]/).pop() ?? path, path }])
  }

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <ul className="attachments" data-testid="attachments">
          {attachments.map((a, i) => (
            <li key={`${a.name}-${i}`}>
              {a.kind === 'bytes' ? <img src={a.previewUrl} alt={a.name} /> : <span>{a.name}</span>}
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(i)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={input}
        value={text}
        rows={3}
        placeholder={placeholder}
        autoFocus={autoFocus}
        data-testid="prompt"
        onChange={(e) => setText(e.target.value)}
        onPaste={paste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-bar">
        <button type="button" onClick={pick}>Add picture</button>
        <span className="spacer" />
        {running && onStop ? (
          <button type="button" onClick={onStop} data-testid="stop">Stop</button>
        ) : (
          <button type="button" className="primary" onClick={submit} data-testid="send" disabled={!text.trim() && attachments.length === 0}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
