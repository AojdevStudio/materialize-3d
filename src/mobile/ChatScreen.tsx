import { type CSSProperties, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatView as SavedChat, MobileChat, ModelChoice, ModelFile, ModelOption } from '../../sidecar/src/protocol'
import { ChatView } from '../studio/Chat'
import ModelPicker from '../studio/ModelPicker'
import ModelView from '../studio/ModelView'
import { Handoff } from '../studio/Trace'
import { buildChat, type HandoffItem } from '../studio/transcript'
import { linkLine, merge, useSession } from './live'
import { canSend, type Outbox } from './outbox'
import { PREVIEW_LIMIT, remoteJson, remoteUrl, stopModelReads, type Picture } from './remote'

/** The models a chat's next message runs with: its lead, and its helper or null for none. */
export type Roles = { lead: ModelChoice; helper: ModelChoice | null }

const chatPath = (project: string) => `/api/v1/chats/${encodeURIComponent(project)}`
const extOf = (rel: string) => rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
/** Whether this device can show the file: the bridge refuses an answer larger than this, so a larger one is not fetched. */
const fits = (file: ModelFile) => file.size <= PREVIEW_LIMIT
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A picture the person picked, as the computer's draft route takes it. A name the computer would refuse is replaced. */
async function readPicture(file: File, taken: Picture[]): Promise<Picture> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('This device could not read the picture.'))
    reader.readAsDataURL(file)
  })
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(file.name)?.[0] ?? '.jpg'
  const usable = /^[^./][^/]*$/.test(file.name) && !taken.some((p) => p.name === file.name)
  return { name: usable ? file.name : `photo-${taken.length + 1}${ext}`, data: url.slice(url.indexOf(',') + 1) }
}

/**
 * The shared viewer, with its download tied to it: when the viewer goes away (another chat, Chats, or a file too large
 * to show), Rust stops the download it started. A newer model read replaces the last one in Rust on its own.
 */
function RemoteModelView(props: { url: string; ext: string; reset: number }) {
  useEffect(() => () => void stopModelReads(), [])
  // A new file gets a new viewer, which starts from its first angle, while the download stays tied to this one.
  return <ModelView key={props.url} {...props} />
}

/** The screen size at which `mobile.css` shows the model beside or above the chat, with no tabs. */
const TABLET = '(min-width: 600px) and (min-height: 600px)'
const watchTablet = (changed: () => void) => {
  const query = matchMedia(TABLET)
  query.addEventListener('change', changed)
  return () => query.removeEventListener('change', changed)
}
const isTablet = () => matchMedia(TABLET).matches

const OUTBOX_NOTE: Partial<Record<Outbox['kind'], string>> = {
  sending: 'Sending',
  unconfirmed: 'Sent, not confirmed yet. The app asks the computer when it is back.',
  checking: 'Asking the computer whether it got this message',
}

/**
 * One chat as the picked phone and tablet layout shows it. The iPhone switches between the chat and the model with two
 * tabs. The iPad shows both: the model above the chat in portrait, beside it in landscape. `mobile.css` sets which.
 * The chat is the desktop's own chat view, kept live from the computer's stream. The composer is the chat's outbox for
 * this pairing, so a draft and a send outlive the screen, and it holds the desktop's Lead and Helper pickers. The
 * chat's roles are its newest requested pair, and `onPick` asks for a new one. `writing` holds Send while a write to
 * the computer is out or the roles it kept are not read yet.
 */
export default function ChatScreen({
  chat,
  writing,
  onPick,
  onBack,
}: {
  chat: MobileChat
  writing: boolean
  onPick: (change: Partial<Roles>) => void
  onBack: () => void
}) {
  const { link, sends, listen, sender: senderOf } = useSession()
  const sender = senderOf(chat.id)
  const outbox = useSyncExternalStore(sender.subscribe, sender.outbox)
  const kept = useSyncExternalStore(sender.subscribe, sender.saved)
  const [view, setView] = useState<SavedChat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<ModelFile[]>([])
  const [filesError, setFilesError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [tab, setTab] = useState<'chat' | 'model'>('chat')
  // On a phone the viewer loads only once the person opens the Model tab, so reading or replying downloads no model.
  // A tablet shows it at once. Once shown it stays, so its view outlives a switch back to Chat or a smaller screen.
  const tablet = useSyncExternalStore(watchTablet, isTablet)
  const [modelOpened, setModelOpened] = useState(false)
  if (tablet && !modelOpened) setModelOpened(true)
  const chatPane = useRef<HTMLDivElement>(null)
  // A role menu opens 4 px above the composer, which `studio.css` positions it from. The room it has there is measured,
  // as the composer grows with pictures and a phone on its side is short, and `mobile.css` caps the menu to it, so the
  // menu scrolls rather than leave the screen. A composer the Model tab hides has no box, and keeps the last room.
  const composer = useRef<HTMLFormElement>(null)
  const [menuRoom, setMenuRoom] = useState<number | null>(null)
  const composerShown = outbox.kind !== 'loading' && outbox.kind !== 'broken'
  useEffect(() => {
    const form = composer.current
    if (form === null) return
    const measure = () => {
      const box = form.getBoundingClientRect()
      if (box.height > 0) setMenuRoom(Math.max(0, Math.floor(box.top) - 4))
    }
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(form)
    window.addEventListener('resize', measure)
    return () => {
      watcher.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [composerShown])
  /** The model file the person chose. Until then, the newest this device can show, so a sliced file takes over from its draft part. */
  const [chosenFile, setChosenFile] = useState<string | null>(null)
  /** Bumped by Reset view, which turns the viewer back to its first angle without loading the model again. */
  const [viewing, setViewing] = useState(0)

  // A text save still waiting is written when the app leaves the screen, as before iOS suspends it.
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && sender.flush()
    document.addEventListener('visibilitychange', hidden)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      sender.flush()
    }
  }, [sender])

  useEffect(() => listen((change) => change.project === chat.id && setView((shown) => merge(shown, change))), [listen, chat.id])

  // The sender holds whether the turn runs, from the chat's events and whole reads, so Send and the send agree.
  const running = useSyncExternalStore(sender.subscribe, sender.running)
  // A turn that ends may have made a model, so the files are read again for each idle view whose last entry is new.
  // That holds however the end arrives, and the first idle view after opening reads them once more.
  const idleAt = view?.running === false ? (view.entries[view.entries.length - 1]?.id ?? null) : null
  const [ended, setEnded] = useState<number | null>(null)
  if (idleAt !== null && idleAt !== ended) setEnded(idleAt)
  const [tries, setTries] = useState(0)

  // The chat is read whole each time the link comes up, since its changes while the link was down were not heard, and
  // after each message the computer took from this device. The transcript and the models both roles offer load apart
  // from the model files, so one failing leaves the others on screen.
  useEffect(() => {
    if (link !== 'connected') return
    let current = true
    remoteJson<SavedChat>(chatPath(chat.id)).then(
      (opened) => {
        if (!current) return
        setView((shown) => merge(shown, opened))
        sender.setRunning(opened.running, opened.seq)
        setError(null)
      },
      (err) => current && setError(errorText(err)),
    )
    remoteJson<ModelOption[]>('/api/v1/models').then(
      (offered) => {
        if (!current) return
        setModels(offered)
        setModelsError(null)
      },
      (err) => current && setModelsError(`The models to pick from did not load. ${errorText(err)}`),
    )
    return () => {
      current = false
    }
  }, [chat.id, link, sends, tries])

  useEffect(() => {
    if (link !== 'connected') return
    let current = true
    remoteJson<ModelFile[]>(`${chatPath(chat.id)}/files`).then(
      (found) => {
        if (!current) return
        setFiles(found)
        setFilesError(null)
      },
      (err) => current && setFilesError(`The model files did not load. ${errorText(err)}`),
    )
    return () => {
      current = false
    }
  }, [chat.id, link, sends, tries, ended])

  const items = useMemo(() => buildChat(view?.entries ?? [], view === null || running, view?.handoffs ?? []), [view, running])
  // What the chat shows, in the measure the chat follows its newest line by: its items, their lines (a trace's steps,
  // a handoff's progress), whether the turn runs, and each handoff's state. A reread that shows the same is no change.
  const shownLines = items.reduce(
    (count, item) => count + (item.kind === 'trace' ? item.lines.length : item.kind === 'handoff' ? 1 + (item.progress?.steps ?? 0) : 1),
    0,
  )
  // A handoff that ends keeps its line count but changes its state and shows its result, so those count too.
  const handoffs = items.map((item) => (item.kind === 'handoff' ? `${item.state}:${item.result?.length ?? 0}` : '')).join(',')
  const shownState = `${items.length}:${shownLines}:${running}:${handoffs}`
  // The chat keeps itself at its newest line, but cannot while it is hidden, which only a phone-sized screen on the
  // Model tab does. What it showed when it was hidden is noted. When it shows again, the newest line comes into view
  // only if that changed, so a reader who missed nothing keeps their place.
  const chatHidden = !tablet && tab === 'model'
  const shownNow = useRef(shownState)
  useEffect(() => {
    shownNow.current = shownState
  })
  const hiddenAt = useRef<string | null>(null)
  useEffect(() => {
    if (chatHidden) {
      hiddenAt.current = shownNow.current
      return
    }
    if (hiddenAt.current !== null && hiddenAt.current !== shownNow.current) {
      chatPane.current?.querySelector('[data-testid=messages]')?.lastElementChild?.scrollIntoView({ block: 'end' })
    }
    hiddenAt.current = null
  }, [chatHidden])
  const newest = [...items].reverse().find((item): item is HandoffItem => item.kind === 'handoff')
  const file = files.find((f) => f.rel === chosenFile) ?? files.find(fits) ?? files[0]
  const editable = outbox.kind === 'draft'
  const message = outbox.kind === 'loading' || outbox.kind === 'broken' ? null : outbox.message
  const shownLink = linkLine(link, kept)

  return (
    <section className="mobile-chat" data-tab={tab} style={menuRoom === null ? undefined : ({ '--menu-room': `${menuRoom}px` } as CSSProperties)}>
      <header className="mobile-chat-bar">
        <button type="button" className="mobile-back" aria-label="Chats" onClick={onBack}>
          <svg viewBox="0 0 16 16" width={18} height={18} aria-hidden="true">
            <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="mobile-chat-title">
          <h1>{chat.title}</h1>
          <p className={`mobile-linkline mobile-linkline-${shownLink.tone}`}>{shownLink.text}</p>
        </div>
        <div className="mobile-tabs" role="tablist">
          {(['chat', 'model'] as const).map((name) => (
            <button
              type="button"
              role="tab"
              key={name}
              aria-selected={tab === name}
              onClick={() => {
                setTab(name)
                if (name === 'model') setModelOpened(true)
              }}
            >
              {name === 'chat' ? 'Chat' : 'Model'}
            </button>
          ))}
        </div>
      </header>
      <div className="mobile-model-pane">
        {/* A reread that fails leaves the model already shown in place, with the error and Try again above it. */}
        {filesError !== null && (
          <p className="mobile-error">
            {filesError}{' '}
            <button type="button" className="mobile-link" onClick={() => setTries((n) => n + 1)}>
              Try again
            </button>
          </p>
        )}
        {file === undefined ? (
          filesError === null && <p className="preview-note">No model in this chat yet.</p>
        ) : (
          <div className="mobile-viewer">
            {fits(file) ? (
              modelOpened && <RemoteModelView
                // The version loads a model again when the agent rebuilt it in place, as the desktop's fileUrl does.
                url={remoteUrl(`${chatPath(chat.id)}/files/${file.rel.split('/').map(encodeURIComponent).join('/')}?v=${file.modifiedMs}`)} ext={extOf(file.rel)} reset={viewing} />
            ) : (
              <p className="mobile-error mobile-too-large">
                {file.rel} is too large to show on this device (over {PREVIEW_LIMIT / (1024 * 1024)} MB).
              </p>
            )}
            <div className="mobile-file">
              {files.map((f) => (
                <button type="button" key={f.rel} aria-pressed={f.rel === file.rel} onClick={() => setChosenFile(f.rel)}>
                  {f.rel}
                </button>
              ))}
            </div>
            <button type="button" className="mobile-reset" onClick={() => setViewing(viewing + 1)}>
              Reset view
            </button>
          </div>
        )}
        {newest !== undefined && (
          <div className="mobile-newest">
            <Handoff handoff={newest} />
          </div>
        )}
      </div>
      <div className="mobile-chat-pane" ref={chatPane}>
        {error && <p className="mobile-error">{error}</p>}
        {modelsError && <p className="mobile-error">{modelsError}</p>}
        {(error || modelsError) && (
          <button type="button" className="mobile-link" onClick={() => setTries((n) => n + 1)}>
            Try again
          </button>
        )}
        {/* Until a view arrives the screen has no turn to show, though Send still waits on the turn the sender heard of. */}
        <ChatView items={items} running={view !== null && running} startedMs={view?.turn?.startedMs} onError={setError} />
        {outbox.kind === 'broken' && (
          <p className="mobile-error">
            {outbox.detail}{' '}
            <button type="button" className="mobile-link" onClick={sender.reload}>
              Try again
            </button>
          </p>
        )}
        {message && (
          <form
            ref={composer}
            className="composer"
            onSubmit={(event) => {
              event.preventDefault()
              void sender.send()
            }}
          >
            {message.pictures.length > 0 && (
              <ul className="mobile-pictures">
                {message.pictures.map((picture, at) => (
                  <li key={`${at}-${picture.name}`}>
                    <img src={`data:image/${extOf(picture.name) === 'png' ? 'png' : 'jpeg'};base64,${picture.data}`} alt={picture.name} />
                    {editable && (
                      <button type="button" className="mobile-link" aria-label={`Remove ${picture.name}`} onClick={() => sender.removePicture(at)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <textarea value={message.text} rows={1} placeholder="Reply or attach a photo" aria-label="Message" disabled={!editable} onChange={(event) => sender.write(event.target.value)} />
            <div className="composer-bar">
              <label className="attach" aria-disabled={!editable}>
                Add a photo
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={!editable}
                  onChange={(event) => {
                    const picked = event.target.files?.[0]
                    event.target.value = ''
                    if (picked !== undefined) void sender.addPicture(readPicture(picked, message.pictures))
                  }}
                />
              </label>
              <span className="spacer" />
              <span className="model-roles">
                <ModelPicker role="Lead" models={models} chosen={chat.lead} onPick={(lead) => onPick({ lead })} />
                <ModelPicker role="Helper" models={models} chosen={chat.helper} onPick={(helper) => onPick({ helper })} />
              </span>
              <button type="submit" className="primary" disabled={!canSend(link, outbox, running) || writing}>
                Send
              </button>
            </div>
            {(OUTBOX_NOTE[outbox.kind] || outbox.kind === 'unconfirmed') && (
              <p className="mobile-outbox">
                {OUTBOX_NOTE[outbox.kind] && <span className="preview-note">{OUTBOX_NOTE[outbox.kind]}</span>}
                {outbox.kind === 'unconfirmed' && (
                  <button type="button" className="mobile-link" onClick={sender.settle}>
                    Check again
                  </button>
                )}
              </p>
            )}
            {'refused' in outbox && outbox.refused && <p className="mobile-error">{outbox.refused}</p>}
          </form>
        )}
      </div>
    </section>
  )
}
