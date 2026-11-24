import { Channel, invoke } from '@tauri-apps/api/core'

/** The paired computer as Rust shows it to the window. The device token stays in Rust. */
export interface Computer {
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

/** The computer refused the request before it changed anything: a 4xx answer. Any other failed answer leaves that open. */
export class Refused extends Error {}

/** A refusal's words. The computer refuses with `{ error }`, and Rust and Tailscale with plain text. */
function refusal(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string') return parsed.error
  } catch {
    // Plain text, shown as it is.
  }
  return body
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
    const words = refusal(await response.text()) || `The computer answered ${response.status}.`
    throw response.status < 500 ? new Refused(words) : new Error(words)
  }
  return (await response.json()) as T
}

/** The draft saved on the computer under `chat`, as a new revision: its number. */
export async function saveDraft(chat: string, draft: { text: string; pictures: Picture[] }): Promise<number> {
  const saved = await remoteJson<unknown>(`${chat}/draft`, { method: 'PUT', body: draft })
  if (typeof saved === 'object' && saved !== null && 'rev' in saved && typeof saved.rev === 'number') return saved.rev
  throw new Error(`The computer saved the draft with an answer this app cannot read: ${JSON.stringify(saved)}`)
}

/** Whether the chat holds the message sent as `rev`. An answer this app cannot read throws, so it never counts as yes. */
export async function sendAccepted(chat: string, rev: number): Promise<boolean> {
  const answer = await remoteJson<unknown>(`${chat}/sends/${rev}`)
  if (typeof answer === 'object' && answer !== null && 'accepted' in answer && typeof answer.accepted === 'boolean') return answer.accepted
  throw new Error(`The computer answered whether it got the message with something this app cannot read: ${JSON.stringify(answer)}`)
}
