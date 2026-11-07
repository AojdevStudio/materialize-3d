import { useEffect, useRef, type ReactNode } from 'react'
import { pickFile } from '../lib/fileDialog'
import { fileUrl, is3mf } from './api'
import { FileActions } from './RightPanel'
import type { ChatItem } from './transcript'

/** A picture waiting to be sent: a dropped file on disk, or pasted bytes. */
/**
 * A picture waiting to go with the next message: a file on disk, so a draft can keep it. A pasted picture is first kept
 * in a file of the sidecar's, and shows its preview while the window has it.
 */
export type Attachment = { name: string; path: string; previewUrl?: string }

/** The picture a draft keeps at `path`. */
export const savedAttachment = (path: string): Attachment => ({ name: path.split(/[\\/]/).pop() ?? path, path })

/** Frees a pasted picture's preview once it is sent, removed, or left. */
/** A picture pasted into the composer, before it is kept in a file. */
export type PastedPicture = { name: string; bytes: Uint8Array; previewUrl: string }

export function releaseAttachment(attachment: Attachment): void {
  if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl)
}

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
        }
      })}
      {running && <p className="working" data-testid="working">Working…</p>}
      <div ref={end} />
    </div>
  )
}

interface ComposerProps {
  text: string
  onText: (text: string) => void
  attachments: Attachment[]
  onAttach: (files: Attachment[]) => void
  /** Pictures pasted into the composer, with their previews, for the screen they were pasted on to keep. */
  onPaste: (pictures: PastedPicture[]) => void
  onRemove: (index: number) => void
  /** Sends the text and pictures. The owner clears them only once the send succeeds. */
  onSend: () => void
  onStop?: () => void
  /** A turn runs or a send is still being set up, so Send waits. */
  busy: boolean
  running: boolean
  placeholder: string
  autoFocus?: boolean
}

export function Composer({ text, onText, attachments, onAttach, onPaste, onRemove, onSend, onStop, busy, running, placeholder, autoFocus }: ComposerProps) {
  const empty = !text.trim() && attachments.length === 0

  const paste = async (event: React.ClipboardEvent) => {
    const pictures = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (pictures.length === 0) return
    event.preventDefault()
    onPaste(
      await Promise.all(
        pictures.map(async (file, i) => ({
          name: file.name && file.name !== 'image.png' ? file.name : `pasted-${Date.now()}-${i}.${file.type.split('/')[1] ?? 'png'}`,
          bytes: new Uint8Array(await file.arrayBuffer()),
          previewUrl: URL.createObjectURL(file),
        })),
      ),
    )
  }

  const pick = async () => {
    const path = await pickFile({ filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'heic', 'webp', 'gif'] }] })
    if (path) onAttach([savedAttachment(path)])
  }

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <ul className="attachments" data-testid="attachments">
          {attachments.map((a, i) => (
            <li key={`${a.name}-${i}`}>
              {a.previewUrl !== undefined ? <img src={a.previewUrl} alt={a.name} /> : <span>{a.name}</span>}
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(i)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={text}
        rows={3}
        placeholder={placeholder}
        autoFocus={autoFocus}
        data-testid="prompt"
        onChange={(e) => onText(e.target.value)}
        onPaste={paste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (!empty && !busy) onSend()
          }
        }}
      />
      <div className="composer-bar">
        <button type="button" onClick={pick}>Add picture</button>
        <span className="spacer" />
        {running && onStop ? (
          <button type="button" onClick={onStop} data-testid="stop">Stop</button>
        ) : (
          <button type="button" className="primary" onClick={onSend} data-testid="send" disabled={empty || busy}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
