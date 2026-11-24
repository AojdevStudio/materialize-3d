import { Channel, invoke } from '@tauri-apps/api/core'

/** The paired computer as Rust shows it to the window. The device token stays in Rust. */
export interface Computer {
  /** Names this pairing, and changes with every new one. Rust derives it from the token, which it cannot be turned back into. */
  id: string
  name: string
  origin: string
}

export const pairing = {
  current: () => invoke<Computer | null>('paired_computer'),
  pair: (link: string, device: string) => invoke<Computer>('pair', { link, device }),
  forget: () => invoke<void>('forget'),
}

/** Stops the model download a chat left behind, in Rust, where the download runs. */
export const stopModelReads = () => invoke<void>('stop_model_reads')

/** A picture in a draft. `data` is its bytes in base64, as the computer's draft route takes them. */
export interface Picture {
  name: string
  data: string
}

/** A draft as this device keeps it (`src-mobile/src/drafts.rs`). `sent` is a send that went out but was not confirmed. */
export interface DeviceDraft {
  text: string
  pictures: Picture[]
  sent: { rev: number } | null
}

export const deviceDrafts = {
  load: (project: string) => invoke<DeviceDraft | null>('draft_load', { project }),
  save: (project: string, draft: DeviceDraft) => invoke<void>('draft_save', { project, draft }),
}

/** What Rust hears of the link to the computer's event stream (`src-mobile/src/events.rs`). */
export type LinkMessage = { kind: 'connected' } | { kind: 'offline'; detail: string } | { kind: 'event'; event: unknown }

/** Follows the link. A later call replaces the earlier one, so a reload of the window leaves one watcher. */
export const watchLink = (heard: (message: LinkMessage) => void) => invoke<void>('link_watch', { channel: new Channel<LinkMessage>(heard) })

/**
 * The paired computer's service, through Rust's `m3dremote://` protocol (`src-mobile/src/remote.rs`). Rust adds the
 * device token. iOS serves a custom scheme on `localhost`.
 */
/**
 * The largest answer Rust's `m3dremote://` protocol holds, `ANSWER_LIMIT` in `src-mobile/src/remote.rs`. A model file the
 * list says is larger is not fetched at all. A test holds the two equal.
 */
export const PREVIEW_LIMIT = 64 * 1024 * 1024

export const remoteUrl = (path: string) => `m3dremote://localhost${path}`

/** The computer did not answer, so whether the request reached it is not known. Rust answers 502 for this. */
export class Unreachable extends Error {}

/**
 * The computer refused a send before it committed it, so its revision never goes out: a 409, 422, or 423 whose body is
 * `{ error }`. Any other failed answer, as Rust's own 413 or a body that is not the computer's, leaves that open.
 */
export class Refused extends Error {}

const REFUSALS = new Set([409, 422, 423])

/** The words of the computer's `{ error }` answer, or null for a body that is not one, as Rust's and Tailscale's plain text. */
function errorWords(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string') return parsed.error
  } catch {
    // Not JSON, so not the computer's refusal.
  }
  return null
}

export async function remoteJson<T>(path: string, write?: { method: 'PUT' | 'POST'; body: unknown }): Promise<T> {
  let response: Response
  try {
    response = await fetch(
      remoteUrl(path),
      write && { method: write.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(write.body) },
    )
  } catch (err) {
    throw new Unreachable(`The computer did not answer. ${err instanceof Error ? err.message : String(err)}`)
  }
  if (response.status === 502) throw new Unreachable(await response.text())
  if (!response.ok) {
    const body = await response.text()
    const words = errorWords(body)
    if (words !== null && REFUSALS.has(response.status)) throw new Refused(words)
    throw new Error(words || body || `The computer answered ${response.status}.`)
  }
  return (await response.json()) as T
}

/** The draft saved on the computer under `chat`, as a new revision: its number. */
export async function saveDraft(chat: string, draft: { text: string; pictures: Picture[] }): Promise<number> {
  const saved = await remoteJson<unknown>(`${chat}/draft`, { method: 'PUT', body: draft })
  if (typeof saved === 'object' && saved !== null && 'rev' in saved && typeof saved.rev === 'number') return saved.rev
  throw new Error(`The computer saved the draft with an answer this app cannot read: ${JSON.stringify(saved)}`)
}

/**
 * Sends revision `rev` of the draft under `chat`, the path of chat `project`. Resolves once the computer answers with
 * that chat. Any other answer throws, since it says nothing about whether the computer took the send.
 */
export async function sendDraft(chat: string, project: string, rev: number): Promise<void> {
  const sent = await remoteJson<unknown>(`${chat}/send`, { method: 'POST', body: { rev } })
  const to = typeof sent === 'object' && sent !== null && 'project' in sent ? sent.project : null
  if (typeof to === 'object' && to !== null && 'id' in to && to.id === project) return
  throw new Error(`The computer answered the send with something this app cannot read: ${JSON.stringify(sent)}`)
}

/**
 * The computer's final word on the send of `rev`: whether the chat holds its message. A false answer retires `rev`, so
 * it never goes out. An answer this app cannot read throws, so it never counts as either.
 */
export async function settleSend(chat: string, rev: number): Promise<boolean> {
  const answer = await remoteJson<unknown>(`${chat}/sends/${rev}/settle`, { method: 'POST', body: {} })
  if (typeof answer === 'object' && answer !== null && 'accepted' in answer && typeof answer.accepted === 'boolean') return answer.accepted
  throw new Error(`The computer settled the message with something this app cannot read: ${JSON.stringify(answer)}`)
}
