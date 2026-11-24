import { useEffect, useRef, useState } from 'react'
import { cancel, checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner'
import ModelView from '../studio/ModelView'
import { useWindowTheme } from '../studio/theme'
import { pairing, PREVIEW_LIMIT, remoteJson, remoteUrl, stopModelReads, type Computer } from './remote'
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
          onForget={() => pairing.forget().then(() => setScreen({ kind: 'unpaired', step: 'idle' }), (err) => setError(errorText(err)))}
        />
      )}
      {error && <p className="mobile-error" role="alert">{error}</p>}
    </main>
  )
}

/** The name the computer lists this device by. An iPad's web view reports a Mac, which has no touch screen. */
function deviceName(): string {
  return /iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1 ? 'iPad' : 'iPhone'
}

function Pair({ step, onScan, onPicture }: { step: PairStep; onScan: () => void; onPicture: (picture: File) => void }) {
  const busy = step !== 'idle'
  return (
    <section className="mobile-pair">
      <h1>Pair with your computer</h1>
      <p>On your computer, open Materialize 3D and show the pairing code. Both devices need Tailscale on.</p>
      <button type="button" className="mobile-primary" disabled={busy} onClick={onScan}>
        {busy ? 'Pairing' : 'Scan the code'}
      </button>
      <label className="mobile-secondary" aria-disabled={busy}>
        Choose a picture of the code
        <input
          type="file"
          accept="image/*"
          hidden
          disabled={busy}
          onChange={(event) => {
            const picture = event.target.files?.[0]
            event.target.value = ''
            if (picture) onPicture(picture)
          }}
        />
      </label>
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

function Paired({ computer, onForget }: { computer: Computer; onForget: () => void }) {
  const [chats, setChats] = useState<MobileChat[] | null>(null)
  const [open, setOpen] = useState<MobileChat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loads, setLoads] = useState(0)
  const reload = () => setLoads((n) => n + 1)

  // The list reads the computer again each time it shows, after a chat or Refresh, so a chat made on the computer
  // meanwhile appears.
  useEffect(() => {
    if (open !== null) return
    // A newer read replaces this one, so a slow earlier answer cannot put an older list back.
    let current = true
    setError(null)
    remoteJson<MobileChat[]>(api('/chats')).then(
      (listed) => current && setChats(listed),
      (err) => current && setError(errorText(err)),
    )
    return () => {
      current = false
    }
  }, [computer.origin, loads, open])

  if (open !== null) return <Chat chat={open} onBack={() => setOpen(null)} />
  return (
    <section className="mobile-chats">
      <header className="mobile-bar">
        <h1>{computer.name}</h1>
        <button type="button" className="mobile-link" onClick={reload}>
          Refresh
        </button>
        <button type="button" className="mobile-link" onClick={onForget}>
          Forget
        </button>
      </header>
      {error && (
        <p className="mobile-error">
          {error}{' '}
          <button type="button" className="mobile-link" onClick={reload}>
            Try again
          </button>
        </p>
      )}
      {chats === null && !error && <p className="preview-note">Loading chats</p>}
      <ul>
        {chats?.map((chat) => (
          <li key={chat.id}>
            <button type="button" onClick={() => setOpen(chat)}>
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

function Chat({ chat, onBack }: { chat: MobileChat; onBack: () => void }) {
  const [view, setView] = useState<ChatView | null>(null)
  const [files, setFiles] = useState<ModelFile[]>([])
  const [model, setModel] = useState<ModelFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filesError, setFilesError] = useState<string | null>(null)

  // The transcript and the model files load apart, so one failing leaves the other on screen.
  useEffect(() => {
    remoteJson<ChatView>(chatPath(chat.id)).then(setView, (err) => setError(errorText(err)))
    remoteJson<ModelFile[]>(`${chatPath(chat.id)}/files`).then(
      (models) => {
        setFiles(models)
        // The newest file this device can show, so opening a chat never downloads a model it must refuse.
        setModel(models.find(fits) ?? models[0] ?? null)
      },
      (err) => setFilesError(`The model files did not load. ${errorText(err)}`),
    )
  }, [chat.id])

  return (
    <section className="mobile-chat">
      <header className="mobile-bar">
        <button type="button" className="mobile-link" onClick={onBack}>
          Chats
        </button>
        <h1>{chat.title}</h1>
      </header>
      {error && <p className="mobile-error">{error}</p>}
      {filesError && <p className="mobile-error">{filesError}</p>}
      {model && !fits(model) && (
        <p className="mobile-error">
          {model.rel} is too large to show on this device (over {PREVIEW_LIMIT / (1024 * 1024)} MB).
        </p>
      )}
      {model && fits(model) && (
        <div className="mobile-model">
          <RemoteModelView url={remoteUrl(`${chatPath(chat.id)}/files/${model.rel.split('/').map(encodeURIComponent).join('/')}`)} ext={extOf(model.rel)} />
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
          return line && (
            <li key={entry.id} className={`mobile-${line.role}`}>
              {line.text}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
