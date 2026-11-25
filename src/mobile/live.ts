import { createContext, useContext } from 'react'
import type { ChatView } from '../../sidecar/src/protocol'
import type { Link, Sender } from './outbox'

/** Whether `entry` has what `merge` and the chat screen read of every chat entry: a numeric `id` and a string `kind`. */
const isEntry = (entry: unknown) =>
  typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'number' && 'kind' in entry && typeof entry.kind === 'string'

/** A `chat` event from the computer's stream, or null for any other event and for one whose entries are not entries. */
export function chatEvent(event: unknown): ChatView | null {
  if (typeof event !== 'object' || event === null || !('type' in event) || event.type !== 'chat') return null
  if (!('project' in event && typeof event.project === 'string' && 'seq' in event && typeof event.seq === 'number' && 'entries' in event && Array.isArray(event.entries))) return null
  if (!event.entries.every(isEntry)) return null
  return event as unknown as ChatView
}

/**
 * A chat with a change applied, as the desktop window applies it: entries only grow, and the rest comes from whichever
 * was read last by `seq`, so a change read before a full read never puts back a turn that already ended.
 */
export function merge(view: ChatView | null, change: ChatView): ChatView {
  if (view === null) return change
  const byId = new Map(view.entries.map((entry) => [entry.id, entry]))
  for (const entry of change.entries) byId.set(entry.id, entry)
  const entries = [...byId.values()].sort((a, b) => a.id - b.id)
  if (change.seq <= view.seq) return { ...view, entries }
  return { ...change, entries }
}

/** The name the computer lists this device by. An iPad's web view reports a Mac, which has no touch screen. */
export function deviceName(): string {
  return /iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1 ? 'iPad' : 'iPhone'
}

/**
 * The line under the chat title that says whether the computer can be reached, and what that means for the draft.
 * `saved` is whether this device's file holds the draft as it reads now.
 */
export function linkLine(link: Link, saved: boolean): { tone: 'ok' | 'off' | 'wait'; text: string } {
  if (link === 'connected') return { tone: 'ok', text: 'Connected' }
  if (link === 'connecting') return { tone: 'wait', text: 'Connecting' }
  return { tone: 'off', text: saved ? `Computer not reachable. Draft saved on this ${deviceName()}` : 'Computer not reachable' }
}

export type ChatListener = (change: ChatView) => void

/** The paired computer as a chat screen uses it. The paired screen provides it. */
export interface Session {
  link: Link
  /** The chat's one outbox for this pairing, the same each time the chat opens. */
  sender: (project: string) => Sender
  /** Hears each chat change the computer streams, until the returned function is called. */
  listen: (heard: ChatListener) => () => void
  /** Counts the messages the computer took from this device, so an open chat reads itself again after each. */
  sends: number
  /**
   * Counts the times the link came up again, so an open chat reads itself again after each, even when the drop and the
   * return reached the screen together and `link` never changed.
   */
  reconnects: number
}

export const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (session === null) throw new Error('A chat screen needs the paired session around it.')
  return session
}
