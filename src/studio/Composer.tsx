import type { ReactNode } from 'react'
import { pickFile } from '../lib/fileDialog'
import attachIcon from '../assets/icons/attach.svg?raw'

/**
 * A file waiting to go with the next message: a file on disk, so a draft can keep it. A pasted picture is first kept
 * in a file of the sidecar's, and shows its preview while the window has it.
 */
export type Attachment = { name: string; path: string; previewUrl?: string }

/** The file a draft keeps at `path`. */
export const savedAttachment = (path: string): Attachment => ({ name: path.split(/[\\/]/).pop() ?? path, path })

/** A picture pasted into the composer, before it is kept in a file. */
export type PastedPicture = { name: string; file: File }

/** Frees a pasted picture's preview once it is sent, removed, or left. */
export function releaseAttachment(attachment: Attachment): void {
  if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl)
}

interface ComposerProps {
  text: string
  onText: (text: string) => void
  attachments: Attachment[]
  onAttach: (files: Attachment[]) => void
  /** Pictures pasted into the composer, with their previews, for the screen they were pasted on to keep. */
  onPaste: (pictures: PastedPicture[]) => void
  onRemove: (index: number) => void
  /** Sends the text and files. The owner clears them only once the send succeeds. */
  onSend: () => void
  onStop?: () => void
  /** A turn runs or a send is still being set up, so Send waits. */
  busy: boolean
  running: boolean
  placeholder: string
  /** Why Send stays off until setup fixes something. The composer says it in place of the placeholder. */
  locked?: string
  autoFocus?: boolean
  /** What Attach takes, beside the button. */
  hint?: string
  /** The send button's label: Start on the start screen, Send in a chat. */
  sendLabel: string
  /** The model picker, beside the send button. */
  picker: ReactNode
}

export function Composer({ text, onText, attachments, onAttach, onPaste, onRemove, onSend, onStop, busy, running, placeholder, locked, autoFocus, hint, sendLabel, picker }: ComposerProps) {
  const empty = !text.trim() && attachments.length === 0
  const off = empty || busy || locked !== undefined

  const paste = (event: React.ClipboardEvent) => {
    const pictures = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (pictures.length === 0) return
    event.preventDefault()
    // Handed over at once, before any wait, so the pictures stay with the screen they were pasted on.
    onPaste(
      pictures.map((file, i) => ({
        name: file.name && file.name !== 'image.png' ? file.name : `pasted-${Date.now()}-${i}.${file.type.split('/')[1] ?? 'png'}`,
        file,
      })),
    )
  }

  // Any file: a photo, a PDF, a 3MF, an STL, or anything else the agent can read.
  const pick = async () => {
    const path = await pickFile({})
    if (path) onAttach([savedAttachment(path)])
  }

  return (
    <div className={locked === undefined ? 'composer' : 'composer locked'}>
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
        rows={2}
        placeholder={locked ?? placeholder}
        autoFocus={autoFocus}
        data-testid="prompt"
        onChange={(e) => onText(e.target.value)}
        onPaste={paste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (!off) onSend()
          }
        }}
      />
      <div className="composer-bar">
        <button type="button" className="attach" onClick={pick} data-testid="attach">
          <span className="attach-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: attachIcon }} />
          Attach
        </button>
        {hint !== undefined && <span className="composer-hint">{hint}</span>}
        <span className="spacer" />
        {picker}
        {running && onStop ? (
          <button type="button" onClick={onStop} data-testid="stop">Stop</button>
        ) : (
          <button type="button" className="primary" onClick={onSend} data-testid="send" disabled={off}>
            {sendLabel}
          </button>
        )}
      </div>
    </div>
  )
}
