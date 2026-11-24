import { deviceDrafts, Refused, remoteJson, saveDraft, sendAccepted, Unreachable, type DeviceDraft, type Picture } from './remote'

/** The link to the paired computer, as the event stream shows it. */
export type Link = 'connecting' | 'connected' | 'offline'

/** What a draft holds: the words and the pictures that go out together. */
export interface Message {
  text: string
  pictures: Picture[]
}

/**
 * The message of one chat on its way to the computer. Only `draft` takes edits.
 * - `draft`: on this device. `retry` is the revision a send of it already went out as, whose fate the computer said it
 *   does not hold, so a send of the unchanged draft posts that revision again and the computer still starts one job.
 * - `sending`: the draft or send request is in flight.
 * - `unconfirmed`: the send went out as `rev`, and no answer said whether the computer took it: none came, the computer
 *   failed after it may have taken it, or the answer could not be read. The computer is asked about it when it is back.
 * - `checking`: that question is in flight.
 * - `broken`: the device file could not be read. Nothing is written over it until a read of it works.
 * `refused` is the last words the computer gave about this message, shown until a send of it goes out again.
 */
export type Outbox =
  | { kind: 'loading' }
  | { kind: 'broken'; detail: string }
  | { kind: 'draft'; message: Message; retry: number | null; refused: string | null }
  | { kind: 'sending'; message: Message }
  | { kind: 'unconfirmed'; message: Message; rev: number; refused: string | null }
  | { kind: 'checking'; message: Message; rev: number; refused: string | null }

const EMPTY: Message = { text: '', pictures: [] }

/** Text saves wait this long after the last key, so typing writes the file once. */
const SAVE_AFTER_MS = 400
/** The wait before the computer is asked again about a send whose answer was lost, while the link still reads up. */
const RECHECK_MS = 2_000

export const canSend = (link: Link, outbox: Outbox) =>
  link === 'connected' && outbox.kind === 'draft' && (outbox.message.text.trim() !== '' || outbox.message.pictures.length > 0)

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * One chat's outbox, kept outside React so a send that outlives the chat screen still saves its outcome. The paired
 * screen keeps one for each chat, and the chat screen reads it with `useSyncExternalStore`.
 */
export class Sender {
  #outbox: Outbox = { kind: 'loading' }
  #link: Link
  #saving: ReturnType<typeof setTimeout> | undefined
  /** The device file's writes go out one at a time, in order, so an older draft never lands after a newer one. */
  #writes: Promise<unknown> = Promise.resolve()
  /** Set once the device forgets its computer. No write goes out after it. */
  #closed = false
  readonly #heard = new Set<() => void>()
  readonly #chat: string
  /** Called when the computer holds a message this device sent. */
  readonly #sent: () => void

  constructor(
    readonly project: string,
    link: Link,
    sent: () => void,
  ) {
    this.#chat = `/api/v1/chats/${encodeURIComponent(project)}`
    this.#link = link
    this.#sent = sent
    this.#load()
  }

  #load() {
    deviceDrafts.load(this.project).then(
      (saved) => {
        const message = saved === null ? EMPTY : { text: saved.text, pictures: saved.pictures }
        this.#set(saved?.sent ? { kind: 'unconfirmed', message, rev: saved.sent.rev, refused: null } : { kind: 'draft', message, retry: null, refused: null })
        void this.#reconcile()
      },
      (err) => this.#set({ kind: 'broken', detail: errorText(err) }),
    )
  }

  /** Reads the device file again, after it could not be read. */
  reload = () => {
    if (this.#outbox.kind !== 'broken') return
    this.#set({ kind: 'loading' })
    this.#load()
  }

  subscribe = (heard: () => void) => {
    this.#heard.add(heard)
    return () => this.#heard.delete(heard)
  }

  outbox = () => this.#outbox

  #set(outbox: Outbox) {
    this.#outbox = outbox
    for (const heard of this.#heard) heard()
  }

  /** The draft as the device file keeps it. */
  #saved(): DeviceDraft | null {
    const outbox = this.#outbox
    switch (outbox.kind) {
      case 'loading':
      case 'broken':
      case 'sending':
        return null
      case 'draft':
        return { ...outbox.message, sent: outbox.retry === null ? null : { rev: outbox.retry } }
      case 'unconfirmed':
      case 'checking':
        return { ...outbox.message, sent: { rev: outbox.rev } }
    }
  }

  /** Writes the draft now, in place of any text save still waiting. */
  flush = () => {
    clearTimeout(this.#saving)
    this.#saving = undefined
    const draft = this.#saved()
    if (draft !== null) this.#write(draft)
  }

  #write(draft: DeviceDraft) {
    this.#save(draft).catch((err) => {
      const outbox = this.#outbox
      if (outbox.kind === 'draft') this.#set({ ...outbox, refused: errorText(err) })
    })
  }

  /** Writes `draft` to the device file after every write before it. Rejects once the sender is closed. */
  #save(draft: DeviceDraft): Promise<void> {
    const saved = this.#writes.then(() => {
      if (this.#closed) throw new Error('This device forgot the computer, so the draft was not kept.')
      return deviceDrafts.save(this.project, draft)
    })
    // The next write waits for this one whether it lands or not. Its caller hears how it went.
    this.#writes = saved.catch(() => {})
    return saved
  }

  /**
   * Stops every later write and check, as when the device forgets its computer, and resolves once the last write
   * already under way is done, so the drafts can be cleared after it.
   */
  close(): Promise<unknown> {
    this.#closed = true
    clearTimeout(this.#saving)
    return this.#writes
  }

  link(link: Link) {
    this.#link = link
    if (link === 'connected') void this.#reconcile()
  }

  #edit(message: Message) {
    if (this.#outbox.kind !== 'draft') return
    // An edited draft is a new message, so it goes out as a new revision.
    this.#set({ kind: 'draft', message, retry: null, refused: null })
  }

  write(text: string) {
    if (this.#outbox.kind !== 'draft') return
    this.#edit({ ...this.#outbox.message, text })
    clearTimeout(this.#saving)
    this.#saving = setTimeout(this.flush, SAVE_AFTER_MS)
  }

  addPicture(picture: Picture) {
    if (this.#outbox.kind !== 'draft') return
    this.#edit({ ...this.#outbox.message, pictures: [...this.#outbox.message.pictures, picture] })
    this.flush()
  }

  removePicture(at: number) {
    if (this.#outbox.kind !== 'draft') return
    this.#edit({ ...this.#outbox.message, pictures: this.#outbox.message.pictures.filter((_, i) => i !== at) })
    this.flush()
  }

  /**
   * Sends the draft. The computer saves it as a revision, and the device saves that revision before the send goes, so
   * a send whose answer is lost, even across a relaunch, is asked about by its revision and never sent as a second job.
   */
  async send() {
    const outbox = this.#outbox
    if (!canSend(this.#link, outbox) || outbox.kind !== 'draft') return
    const { message } = outbox
    clearTimeout(this.#saving)
    this.#set({ kind: 'sending', message })
    let rev = outbox.retry
    try {
      if (rev === null) {
        // The words as typed reach the device first, so a computer that never answers loses none of them.
        await this.#save({ ...message, sent: null })
        rev = await saveDraft(this.#chat, message)
        await this.#save({ ...message, sent: { rev } })
      }
    } catch (err) {
      // No send went out, so the draft stays as it was.
      this.#set({ kind: 'draft', message, retry: null, refused: errorText(err) })
      this.flush()
      return
    }
    try {
      await remoteJson(`${this.#chat}/send`, { method: 'POST', body: { rev } })
    } catch (err) {
      if (err instanceof Refused) {
        // Refused before it committed, so this revision never goes out and the next send saves the draft again.
        this.#set({ kind: 'draft', message, retry: null, refused: errorText(err) })
        this.flush()
        return
      }
      if (err instanceof Unreachable) {
        this.#set({ kind: 'unconfirmed', message, rev, refused: null })
        this.#recheck()
        return
      }
      // The computer answered, so it is asked at once whether it took the send.
      this.#set({ kind: 'unconfirmed', message, rev, refused: errorText(err) })
      return this.#reconcile()
    }
    this.#done()
  }

  #done() {
    this.#set({ kind: 'draft', message: EMPTY, retry: null, refused: null })
    this.flush()
    this.#sent()
  }

  #recheck() {
    setTimeout(() => void this.#reconcile(), RECHECK_MS)
  }

  /** Asks the computer whether it holds the unconfirmed send, once the link is up. */
  async #reconcile() {
    const outbox = this.#outbox
    if (this.#closed || outbox.kind !== 'unconfirmed' || this.#link !== 'connected') return
    const { message, rev, refused } = outbox
    this.#set({ kind: 'checking', message, rev, refused })
    try {
      if (await sendAccepted(this.#chat, rev)) return this.#done()
      this.#set({ kind: 'draft', message, retry: rev, refused })
    } catch (err) {
      if (err instanceof Refused) {
        // A send of the same revision is safe to retry, so the draft comes back with it.
        this.#set({ kind: 'draft', message, retry: rev, refused: errorText(err) })
        return
      }
      // No answer, or one this app cannot read, says nothing about the send, so it is asked about again.
      this.#set({ kind: 'unconfirmed', message, rev, refused: err instanceof Unreachable ? refused : errorText(err) })
      this.#recheck()
    }
  }
}
