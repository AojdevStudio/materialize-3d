import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { cancel, checkPermissions, Format, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner'
import { useWindowTheme } from '../studio/theme'
import ChatScreen, { type Roles } from './ChatScreen'
import { pairing, remoteJson, Unreachable, watchLink, type Computer } from './remote'
import { Sender, type Link } from './outbox'
import { chatEvent, deviceName, SessionContext, type ChatListener, type Session } from './live'
import { readQrPicture } from './qr'
import type { MobileChat } from '../../sidecar/src/protocol'
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

/**
 * Whether an event from the computer's stream says a chat changed, as when the desktop picked a new pair. It carries no
 * order against this device's own saves, so it only asks for a fresh read of the list.
 */
const isProjectEvent = (event: unknown) => typeof event === 'object' && event !== null && 'type' in event && event.type === 'project'

/** Runs a write to the paired computer after every write before it. */
type Write = <T>(work: () => Promise<T>) => Promise<T>

/**
 * The paired computer: its chats, the link to it, one outbox per chat, and the one lane its writes take. Role picks and
 * sends go out in the order the person made them, from any chat screen: a pick before Send applies to that message, and
 * a pick after it to the next one. Forget acts at once: no write still waiting goes out after it. The list shows each
 * chat's newest requested pair, and each time the lane drains, or a Forget fails, it is read again, so it ends on what
 * the computer kept.
 */
function Paired({ computer, onForget }: { computer: Computer; onForget: () => Promise<void> }) {
  const [chats, setChats] = useState<MobileChat[] | null>(() => savedChats(computer.id))
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Why the last Forget failed. Its own line, so the chat list's reread after it does not clear it. */
  const [forgetError, setForgetError] = useState<string | null>(null)
  const [loads, setLoads] = useState(0)
  const reload = () => setLoads((n) => n + 1)
  const [link, setLink] = useState<Link>('connecting')
  const [sends, setSends] = useState(0)
  const [reconnects, setReconnects] = useState(0)
  const [writing, setWriting] = useState(0)
  /**
   * True from the start of each write, and from the moment the link comes up, until a list read after them shows the
   * pairs the computer holds. Send waits for it, so a message never goes out with a pair other than the one shown, even
   * when the desktop changed the pair while a write was out and its event was not applied.
   */
  const [unsure, setUnsure] = useState(false)
  /** The same as `unsure`, for a read's answer to see: a read Send waits on shows its failure, with Try again. */
  const required = useRef(false)
  const hold = (held: boolean) => {
    required.current = held
    // A read begun before a hold cannot know what made it, so only a read begun after it may let Send go.
    if (held) heldAt.current = lists.current
    setUnsure(held)
  }
  /** Set the moment the person taps Forget. From then on the old pairing opens no chat, keeps no list, and hears no chat event. */
  const closing = useRef(false)
  /** One outbox per chat for this pairing, so a chat opened again finds the send it left going out. */
  const senders = useRef(new Map<string, Sender>())
  const listeners = useRef(new Set<ChatListener>())
  const [listen] = useState(() => (heard: ChatListener) => {
    listeners.current.add(heard)
    return () => listeners.current.delete(heard)
  })
  const lane = useRef(Promise.resolve())
  /** Writes started and finished. A list read while one was out, or before one began, may hold an older pair. */
  const writes = useRef({ started: 0, finished: 0 })
  /** Counts Forget taps. A write waiting when one came never goes out, even if that Forget then fails. */
  const forgets = useRef(0)
  /** Counts list reads. Each read takes the next number. */
  const lists = useRef(0)
  /** The newest read whose answer was taken. An older one that answers later is dropped. */
  const applied = useRef(0)
  /** The number of the last read begun before the latest hold. Its answer and those before it are dropped. */
  const heldAt = useRef(0)
  /** Whether the link is up, for the link handler and a list read's answer to see. */
  const connected = useRef(false)

  useEffect(() => {
    watchLink((message) => {
      // The link stays current while Forget waits, so a Forget that fails leaves it right.
      if (message.kind === 'connected') {
        // Pairs changed elsewhere while the link was down were not heard, so Send waits for a list read started now.
        // The hold lands in the same render as the link, so Send is never on in between, and the new read drops any
        // read begun before the link came back, so an older answer cannot let Send go.
        if (!connected.current) {
          hold(true)
          connected.current = true
          setError(null)
          setReconnects((n) => n + 1)
          refresh()
        }
        return setLink('connected')
      }
      if (message.kind === 'offline') {
        connected.current = false
        return setLink('offline')
      }
      if (closing.current) return
      const change = chatEvent(message.event)
      if (change !== null) {
        // A chat that is not open still learns whether its turn runs, so it shows the right Send when it opens again.
        senders.current.get(change.project)?.setRunning(change.running, change.seq)
        for (const heard of listeners.current) heard(change)
      }
      // A chat changed on the computer, maybe its pair. The event may be older than a pair this device already
      // confirmed, so it changes nothing shown: Send waits while a new list read, which drops any older one, shows the
      // pair the computer holds. While this device's own writes are out, the read after them shows it.
      if (isProjectEvent(message.event) && writes.current.finished === writes.current.started) {
        // Send turns off before this event's task ends, so a tap already queued behind it finds it off.
        flushSync(() => hold(true))
        refresh()
      }
    }).catch((err) => setError(errorText(err)))
  }, [computer.id])

  // Each sender hears each reconnect too, so a send left unconfirmed is settled even when the drop and the return
  // reached the screen together.
  useEffect(() => {
    for (const sender of senders.current.values()) sender.link(link)
  }, [link, reconnects])

  // The list reads the computer again each time it shows, after a chat or Refresh, so a chat made on the computer
  // meanwhile appears. While the computer is away, the list from the last read stands, and the link says why it is not
  // newer. A read that fails while the link is up, or while Send waits on it, shows why. A read that ends after the
  // device forgot the computer keeps nothing.
  /** Whether the error shown came from a list read, so the next read that works takes it away. */
  const listFailed = useRef(false)
  const refresh = () => {
    const request = ++lists.current
    const before = writes.current.started
    const quiet = writes.current.finished === before
    remoteJson<MobileChat[]>(api('/chats')).then(
      (listed) => {
        // A newer read that failed does not drop this answer, but one that succeeded does, and so does a hold since.
        if (request <= applied.current || request <= heldAt.current || !quiet || writes.current.started !== before || closing.current) return
        applied.current = request
        // The pairs and the release of Send land in one render, so Send never lets go while the old pairs show.
        flushSync(() => {
          setChats(listed)
          hold(false)
        })
        if (listFailed.current) {
          listFailed.current = false
          setError(null)
        }
        try {
          localStorage.setItem(CHATS_KEY, JSON.stringify({ pairing: computer.id, chats: listed }))
        } catch {
          // No storage: the next launch reads the list from the computer.
        }
      },
      (err) => {
        if (request !== lists.current || !(required.current || connected.current || !(err instanceof Unreachable))) return
        listFailed.current = true
        setError(errorText(err))
      },
    )
  }

  // Read at once and on each return to the list, not on opening a chat, whose extra read would drop a reconnect's.
  // Each time the link comes up, the reconnect reads the list itself, so a list that failed while the computer was
  // away comes back, with one read only.
  const onList = openId === null
  useEffect(() => {
    if (!onList) return
    setError(null)
    refresh()
  }, [computer.id, loads, onList])

  const write: Write = (work) => {
    writes.current.started += 1
    hold(true)
    setWriting((n) => n + 1)
    const run = lane.current.then(work)
    lane.current = run.then(
      () => undefined,
      () => undefined,
    )
    return run.finally(() => {
      writes.current.finished += 1
      setWriting((n) => n - 1)
      if (!closing.current && writes.current.finished === writes.current.started) refresh()
    })
  }

  const pick = (chat: string, change: Partial<Roles>) => {
    setChats((all) => all?.map((c) => (c.id === chat ? { ...c, ...change } : c)) ?? null)
    // A pick still waiting when Forget is tapped never goes out, even if that Forget fails. A send holds itself back
    // while Forget runs, and goes on if it fails.
    const forgetsBefore = forgets.current
    write(() =>
      closing.current || forgets.current !== forgetsBefore
        ? Promise.resolve(undefined)
        : remoteJson<Roles>(`${api('/chats')}/${encodeURIComponent(chat)}/roles`, { method: 'PUT', body: change }),
    ).catch((err: unknown) => {
      listFailed.current = false
      setError(errorText(err))
      hold(true)
    })
  }

  const session = useMemo<Session>(
    () => ({
      link,
      sends,
      reconnects,
      listen,
      sender: (project) => {
        let sender = senders.current.get(project)
        if (sender === undefined) {
          if (closing.current) throw new Error('This device is forgetting the computer, so it opens no chat.')
          // A send takes the lane, so it goes out after every pick before it and before every pick after it.
          sender = new Sender(project, link, () => setSends((n) => n + 1), write)
          senders.current.set(project, sender)
        }
        return sender
      },
    }),
    [link, sends, reconnects, listen],
  )

  // Every sender pauses before anything waits, so nothing goes to the computer. Its draft writes already queued land
  // before Rust clears the drafts. A Forget that fails lets the same senders go on, with their newest words.
  const forget = async () => {
    // A second tap while a Forget runs would pause senders the first one may yet resume.
    if (closing.current) return
    setForgetError(null)
    closing.current = true
    forgets.current += 1
    const paused = [...senders.current.values()]
    await Promise.all(paused.map((sender) => sender.pause()))
    try {
      await onForget()
    } catch (err) {
      closing.current = false
      for (const sender of paused) sender.resume()
      setForgetError(errorText(err))
      // A pick this Forget dropped never went out, and a list the computer sent while Forget waited was dropped, so Send
      // waits for the read that shows the pairs the computer kept.
      hold(true)
      reload()
      return
    }
    for (const sender of paused) sender.close()
    senders.current.clear()
  }

  const open = chats?.find((chat) => chat.id === openId)
  if (open !== undefined)
    return (
      <SessionContext.Provider value={session}>
        <ChatScreen
          chat={open}
          writing={writing > 0 || unsure}
          confirmed={() => connected.current && !required.current && writes.current.finished === writes.current.started}
          onPick={(change) => pick(open.id, change)}
          onBack={() => setOpenId(null)}
        />
        {error && (
          <p className="mobile-error" role="alert">
            {error}{' '}
            <button
              type="button"
              className="mobile-link"
              onClick={() => {
                setError(null)
                refresh()
              }}
            >
              Try again
            </button>
          </p>
        )}
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
            <button type="button" onClick={() => !closing.current && setOpenId(chat.id)}>
              {chat.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
