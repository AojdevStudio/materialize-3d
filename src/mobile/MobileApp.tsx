import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { cancel, checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner'
import ModelView from '../studio/ModelView'
import { useWindowTheme } from '../studio/theme'
import { pairing, PREVIEW_LIMIT, remoteJson, remoteUrl, stopModelReads, Unreachable, watchLink, type Computer, type Picture } from './remote'
import { canSend, Sender, type Link, type Outbox } from './outbox'
import { chatEvent, deviceName, linkLine, merge, SessionContext, useSession, type ChatListener, type Session } from './live'
import { readQrPicture } from './qr'
import type { ChatEntry, ChatView, MobileChat, ModelFile } from '../../sidecar/src/protocol'
import '../studio/studio.css'
import './mobile.css'

/**
 * The pairing screen's steps. One code is read and redeemed at a time, so a second scan or picture cannot race it.
 * `scanning` makes the window see-through over the native camera, with only Cancel on it.
 */
type PairStep = 'idle' | 'reading' | 'scanning' | 'redeeming'
type Screen = { kind: 'loading' } | { kind: 'unpaired'; step: PairStep } | { kind: 'paired'; computer: Computer }

/** A rejection's words. Rust commands reject with a string, and a native plugin with an object that holds a message. */
function errorText(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err && typeof err.message === 'string') return err.message
  return JSON.stringify(err)
}

/** The text of the QR code the camera sees, once the person allows the camera. A Cancel while iOS asks starts no scan. */
async function scanCode(cancelled: () => boolean): Promise<string | null> {
  const granted = (await checkPermissions()) === 'granted'
  if (cancelled()) return null
  const allowed = granted || (await requestPermissions()) === 'granted'
  if (!allowed) throw new Error('Materialize 3D needs the camera to scan the code. Allow the camera in Settings, or choose a picture of the code.')
  if (cancelled()) return null
  return (await scan({ windowed: true, formats: [Format.QRCode] })).content
}

export default function MobileApp() {
  useWindowTheme()
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const cancelled = useRef(false)

  useEffect(() => {
    pairing.current().then(
      (computer) => setScreen(computer ? { kind: 'paired', computer } : { kind: 'unpaired', step: 'idle' }),
      (err) => {
        setScreen({ kind: 'unpaired', step: 'idle' })
        setError(errorText(err))
      },
    )
  }, [])

  /** Reads a link with `read`, then redeems it. A read already under way makes this a no-op. */
  const pairFrom = async (step: 'reading' | 'scanning', read: () => Promise<string | null>) => {
    if (busy.current) return
    busy.current = true
    cancelled.current = false
    setError(null)
    setScreen({ kind: 'unpaired', step })
    try {
      const link = await read()
      // A Cancel during the read wins: a late result redeems nothing.
      if (cancelled.current) return setScreen({ kind: 'unpaired', step: 'idle' })
      if (link === null) throw new Error('No pairing code was found in that picture.')
      setScreen({ kind: 'unpaired', step: 'redeeming' })
      setScreen({ kind: 'paired', computer: await pairing.pair(link, deviceName()) })
    } catch (err) {
      setScreen({ kind: 'unpaired', step: 'idle' })
      if (!cancelled.current) setError(errorText(err))
    } finally {
      busy.current = false
    }
  }

  const stopScan = () => {
    cancelled.current = true
    void cancel()
  }

  return (
    <main className={screen.kind === 'unpaired' && screen.step === 'scanning' ? 'mobile mobile-scanning' : 'mobile'}>
      {screen.kind === 'unpaired' && screen.step === 'scanning' && (
        <div className="mobile-scan">
          <p>Point the camera at the code on your computer.</p>
          <button type="button" className="mobile-primary" onClick={stopScan}>
            Cancel
          </button>
        </div>
      )}
      {screen.kind === 'unpaired' && screen.step !== 'scanning' && (
        <Pair
          step={screen.step}
          onScan={() => pairFrom('scanning', () => scanCode(() => cancelled.current))}
          onPicture={(picture) => pairFrom('reading', () => readQrPicture(picture))}
        />
      )}
      {screen.kind === 'paired' && (
        <Paired
          computer={screen.computer}
          onForget={async () => {
            await pairing.forget()
            try {
              localStorage.removeItem(CHATS_KEY)
            } catch {
              // No storage, so no list was kept.
            }
            setScreen({ kind: 'unpaired', step: 'idle' })
          }}
        />
      )}
      {error && <p className="mobile-error" role="alert">{error}</p>}
    </main>
  )
}

function Pair({ step, onScan, onPicture }: { step: PairStep; onScan: () => void; onPicture: (picture: File) => void }) {
  const busy = step !== 'idle'
  // A real button opens the native chooser, so the photo path is reachable by keyboard too.
  const picker = useRef<HTMLInputElement>(null)
  return (
    <section className="mobile-pair">
      <h1>Pair with your computer</h1>
      <p>On your computer, open Materialize 3D and show the pairing code. Both devices need Tailscale on.</p>
      <button type="button" className="mobile-primary" disabled={busy} onClick={onScan}>
        {busy ? 'Pairing' : 'Scan the code'}
      </button>
      <button type="button" className="mobile-secondary" disabled={busy} onClick={() => picker.current?.click()}>
        Choose a picture of the code
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        className="mobile-picker"
        data-testid="picture-input"
        tabIndex={-1}
        aria-hidden
        disabled={busy}
        onChange={(event) => {
          const picture = event.target.files?.[0]
          event.target.value = ''
          if (picture) onPicture(picture)
        }}
      />
    </section>
  )
}

const api = (path: string) => `/api/v1${path}`
const chatPath = (project: string) => api(`/chats/${encodeURIComponent(project)}`)
const fits = (file: ModelFile) => file.size <= PREVIEW_LIMIT

/**
 * The shared viewer, with its download tied to it: when the viewer goes away (another chat, Chats, or a file too large
 * to show), Rust stops the download it started. A newer model read replaces the last one in Rust on its own.
 */
function RemoteModelView(props: { url: string; ext: string }) {
  useEffect(() => () => void stopModelReads(), [])
  return <ModelView {...props} />
}
const extOf = (rel: string) => rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()

/**
 * The chat list as last read, with the pairing it came from, so a person can open a chat and its draft while the
 * computer is out of reach. A list kept for another pairing is never shown.
 */
const CHATS_KEY = 'm3d.chats'

function savedChats(pairing: string): MobileChat[] | null {
  try {
    const saved = localStorage.getItem(CHATS_KEY)
    if (saved === null) return null
    const kept = JSON.parse(saved) as { pairing: string; chats: MobileChat[] }
    return kept.pairing === pairing ? kept.chats : null
  } catch {
    // No storage, as in a private window: the list waits for the computer.
    return null
  }
}

function Paired({ computer, onForget }: { computer: Computer; onForget: () => Promise<void> }) {
  const [chats, setChats] = useState<MobileChat[] | null>(() => savedChats(computer.id))
  const [open, setOpen] = useState<MobileChat | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Why the last Forget failed. Its own line, so the chat list's reread after it does not clear it. */
  const [forgetError, setForgetError] = useState<string | null>(null)
  const [loads, setLoads] = useState(0)
  const reload = () => setLoads((n) => n + 1)
  const [link, setLink] = useState<Link>('connecting')
  const [sends, setSends] = useState(0)
  /** Set the moment the person taps Forget. From then on the old pairing opens no chat, keeps no list, and hears no chat event. */
  const closing = useRef(false)
  /** One outbox per chat for this pairing, so a chat opened again finds the send it left going out. */
  const senders = useRef(new Map<string, Sender>())
  const listeners = useRef(new Set<ChatListener>())
  const [listen] = useState(() => (heard: ChatListener) => {
    listeners.current.add(heard)
    return () => listeners.current.delete(heard)
  })
  const up = link === 'connected'

  useEffect(() => {
    watchLink((message) => {
      // The link stays current while Forget waits, so a Forget that fails leaves it right.
      if (message.kind === 'connected') return setLink('connected')
      if (message.kind === 'offline') return setLink('offline')
      if (closing.current) return
      const change = chatEvent(message.event)
      if (change === null) return
      // A chat that is not open still learns whether its turn runs, so it shows the right Send when it opens again.
      senders.current.get(change.project)?.setRunning(change.running, change.seq)
      for (const heard of listeners.current) heard(change)
    }).catch((err) => setError(errorText(err)))
  }, [computer.id])

  useEffect(() => {
    for (const sender of senders.current.values()) sender.link(link)
  }, [link])

  // The list reads the computer again each time it shows, after a chat or Refresh, so a chat made on the computer
  // meanwhile appears, and each time the link comes up, so a list that failed while the computer was away comes back.
  // While it is away, the list from the last read stands, and the link says why it is not newer. A read that fails while
  // the link is up shows why. A read that ends after the device forgot the computer keeps nothing.
  useEffect(() => {
    if (open !== null) return
    // A newer read replaces this one, so a slow earlier answer cannot put an older list back.
    let current = true
    setError(null)
    remoteJson<MobileChat[]>(api('/chats')).then(
      (listed) => {
        if (!current || closing.current) return
        setChats(listed)
        try {
          localStorage.setItem(CHATS_KEY, JSON.stringify({ pairing: computer.id, chats: listed }))
        } catch {
          // No storage: the next launch reads the list from the computer.
        }
      },
      (err) => {
        if (current && (up || !(err instanceof Unreachable))) setError(errorText(err))
      },
    )
    return () => {
      current = false
    }
  }, [computer.id, loads, up, open])

  const session = useMemo<Session>(
    () => ({
      link,
      sends,
      listen,
      sender: (project) => {
        let sender = senders.current.get(project)
        if (sender === undefined) {
          if (closing.current) throw new Error('This device is forgetting the computer, so it opens no chat.')
          sender = new Sender(project, link, () => setSends((n) => n + 1))
          senders.current.set(project, sender)
        }
        return sender
      },
    }),
    [link, sends, listen],
  )

  // Every sender pauses before anything waits, so nothing goes to the computer. Its draft writes already queued land
  // before Rust clears the drafts. A Forget that fails lets the same senders go on, with their newest words.
  const forget = async () => {
    // A second tap while a Forget runs would pause senders the first one may yet resume.
    if (closing.current) return
    setForgetError(null)
    closing.current = true
    const paused = [...senders.current.values()]
    await Promise.all(paused.map((sender) => sender.pause()))
    try {
      await onForget()
    } catch (err) {
      closing.current = false
      for (const sender of paused) sender.resume()
      setForgetError(errorText(err))
      // A list the computer sent while Forget waited was dropped, so read it again.
      reload()
      return
    }
    for (const sender of paused) sender.close()
    senders.current.clear()
  }

  if (open !== null)
    return (
      <SessionContext.Provider value={session}>
        <Chat chat={open} onBack={() => setOpen(null)} />
      </SessionContext.Provider>
    )
  return (
    <section className="mobile-chats">
      <header className="mobile-bar">
        <h1>{computer.name}</h1>
        <button type="button" className="mobile-link" onClick={reload}>
          Refresh
        </button>
        <button type="button" className="mobile-link" onClick={forget}>
          Forget
        </button>
      </header>
      {forgetError && (
        <p className="mobile-error" role="alert">
          {forgetError}
        </p>
      )}
      {error && (
        <p className="mobile-error">
          {error}{' '}
          <button type="button" className="mobile-link" onClick={reload}>
            Try again
          </button>
        </p>
      )}
      {chats === null && !error && <p className="preview-note">{link === 'offline' ? 'Computer not reachable' : 'Loading chats'}</p>}
      <ul>
        {chats?.map((chat) => (
          <li key={chat.id}>
            <button type="button" onClick={() => !closing.current && setOpen(chat)}>
              {chat.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The words of a chat line, or null for a line this thin shell does not show, such as a tool result. */
function lineText(entry: ChatEntry): { role: 'user' | 'assistant'; text: string } | null {
  if (entry.kind === 'user' || (entry.kind === 'imported' && entry.role === 'user')) return { role: 'user', text: entry.text }
  if (entry.kind === 'assistant' || (entry.kind === 'imported' && entry.role === 'assistant')) return entry.text ? { role: 'assistant', text: entry.text } : null
  return null
}

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

const OUTBOX_NOTE: Partial<Record<Outbox['kind'], string>> = {
  sending: 'Sending',
  unconfirmed: 'Sent, not confirmed yet. The app asks the computer when it is back.',
  checking: 'Asking the computer whether it got this message',
}

function Chat({ chat, onBack }: { chat: MobileChat; onBack: () => void }) {
  const { link, sends, listen, sender: senderOf } = useSession()
  const sender = senderOf(chat.id)
  const [view, setView] = useState<ChatView | null>(null)
  const [files, setFiles] = useState<ModelFile[]>([])
  const [model, setModel] = useState<ModelFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)
  const outbox = useSyncExternalStore(sender.subscribe, sender.outbox)

  // A text save still waiting is written when the app leaves the screen, as before iOS suspends it.
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && sender.flush()
    document.addEventListener('visibilitychange', hidden)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      sender.flush()
    }
  }, [sender])

  useEffect(() => listen((change) => change.project === chat.id && setView((kept) => merge(kept, change))), [listen, chat.id])

  // The sender holds whether the turn runs, from the chat's events and whole reads, so Send and the send agree.
  const running = useSyncExternalStore(sender.subscribe, sender.running)
  // A turn that ends may have made a model, so the files are read again for each idle view whose last entry is new.
  // That holds however the end arrives, and the first idle view after opening reads them once more.
  const idleAt = view?.running === false ? (view.entries[view.entries.length - 1]?.id ?? null) : null
  const [ended, setEnded] = useState<number | null>(null)
  if (idleAt !== null && idleAt !== ended) setEnded(idleAt)
  const [tries, setTries] = useState(0)

  // The chat is read whole each time the link comes up, since its changes while the link was down were not heard. The
  // transcript and the model files load apart, so one failing leaves the other on screen.
  useEffect(() => {
    if (link !== 'connected') return
    let current = true
    remoteJson<ChatView>(chatPath(chat.id)).then(
      (opened) => {
        if (!current) return
        setView((kept) => merge(kept, opened))
        sender.setRunning(opened.running, opened.seq, true)
        setError(null)
      },
      (err) => current && setError(errorText(err)),
    )
    return () => {
      current = false
    }
  }, [chat.id, link, sends, tries])

  useEffect(() => {
    if (link !== 'connected') return
    let current = true
    remoteJson<ModelFile[]>(`${chatPath(chat.id)}/files`).then(
      (models) => {
        if (!current) return
        setFiles(models)
        // The file shown before a reread, else the newest file this device can show, so opening a chat never downloads
        // a model it must refuse.
        setModel((shown) => models.find((file) => file.rel === shown?.rel) ?? models.find(fits) ?? models[0] ?? null)
        setFilesError(null)
      },
      (err) => current && setFilesError(`The model files did not load. ${errorText(err)}`),
    )
    return () => {
      current = false
    }
  }, [chat.id, link, sends, tries, ended])

  const editable = outbox.kind === 'draft'
  const saved = useSyncExternalStore(sender.subscribe, sender.saved)
  const message = outbox.kind === 'loading' || outbox.kind === 'broken' ? null : outbox.message
  const shownLink = linkLine(link, saved)

  return (
    <section className="mobile-chat">
      <header className="mobile-bar">
        <button type="button" className="mobile-link" onClick={onBack}>
          Chats
        </button>
        <h1>{chat.title}</h1>
      </header>
      <p className={`mobile-linkline mobile-linkline-${shownLink.tone}`}>{shownLink.text}</p>
      {error && <p className="mobile-error">{error}</p>}
      {filesError && <p className="mobile-error">{filesError}</p>}
      {(error || filesError) && (
        <button type="button" className="mobile-link" onClick={() => setTries((n) => n + 1)}>
          Try again
        </button>
      )}
      {model && !fits(model) && (
        <p className="mobile-error">
          {model.rel} is too large to show on this device (over {PREVIEW_LIMIT / (1024 * 1024)} MB).
        </p>
      )}
      {model && fits(model) && (
        <div className="mobile-model">
          {/* The version loads a model again when the agent rebuilt it in place, as the desktop's fileUrl does. */}
          <RemoteModelView url={remoteUrl(`${chatPath(chat.id)}/files/${model.rel.split('/').map(encodeURIComponent).join('/')}?v=${model.modifiedMs}`)} ext={extOf(model.rel)} />
        </div>
      )}
      {files.length > 0 && (
        <div className="mobile-files">
          {files.map((file) => (
            <button type="button" key={file.rel} aria-pressed={file.rel === model?.rel} onClick={() => setModel(file)}>
              {file.rel}
            </button>
          ))}
        </div>
      )}
      <ol className="mobile-transcript">
        {view?.entries.map((entry) => {
          const line = lineText(entry)
          return (
            line && (
              <li key={entry.id} className={`mobile-${line.role}`}>
                {line.text}
              </li>
            )
          )
        })}
      </ol>
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
          className="mobile-composer"
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
          <textarea aria-label="Message" rows={2} value={message.text} disabled={!editable} onChange={(event) => sender.write(event.target.value)} />
          <div className="mobile-send">
            <label className="mobile-link" aria-disabled={!editable}>
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
            {OUTBOX_NOTE[outbox.kind] && <span className="preview-note">{OUTBOX_NOTE[outbox.kind]}</span>}
            {outbox.kind === 'unconfirmed' && (
              <button type="button" className="mobile-link" onClick={sender.settle}>
                Check again
              </button>
            )}
            <button type="submit" className="mobile-primary" disabled={!canSend(link, outbox, running)}>
              Send
            </button>
          </div>
          {'refused' in outbox && outbox.refused && <p className="mobile-error">{outbox.refused}</p>}
        </form>
      )}
    </section>
  )
}
