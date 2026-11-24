import { deviceDrafts, Refused, saveDraft, sendDraft, settleSend, type Picture } from './remote'

/** The link to the paired computer, as the event stream shows it. */
export type Link = 'connecting' | 'connected' | 'offline'

/** What a draft holds: the words and the pictures that go out together. */
export interface Message {
  text: string
  pictures: Picture[]
}

/**
 * The message of one chat on its way to the computer. Only `draft` takes edits.
 * - `draft`: on this device, and no send of it is open. The next send saves it on the computer as a new revision.
 * - `sending`: the saves and the send are in flight.
 * - `unconfirmed`: the send went out as `rev`, and no answer said whether the computer took it: none came, the computer
 *   failed after it may have taken it, or the answer could not be read. It is settled when the link comes up, or when
 *   the person checks again.
 * - `checking`: the settle is in flight. Its answer is final: the computer holds the message, or it never will.
 * - `broken`: the device file could not be read. Nothing is written over it until a read of it works.
 * `refused` is the last words the computer or the link gave about this message.
 */
export type Outbox =
  | { kind: 'loading' }
  | { kind: 'broken'; detail: string }
  | { kind: 'draft'; message: Message; refused: string | null }
  | { kind: 'sending'; message: Message }
  | { kind: 'unconfirmed'; message: Message; rev: number; refused: string | null }
  | { kind: 'checking'; message: Message; rev: number; refused: string | null }

const EMPTY: Message = { text: '', pictures: [] }

/** Text saves wait this long after the last key, so typing writes the file once. */
const SAVE_AFTER_MS = 400

const FORGOT = 'This device forgot the computer, so the draft was not kept.'

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
  /** The message the device file holds, as the last write that landed wrote it. */
  #written: Message | null = null
  /** Set once the device forgets its computer. No write, save, or send goes out after it. */
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
        this.#written = message
        this.#set(saved?.sent ? { kind: 'unconfirmed', message, rev: saved.sent.rev, refused: null } : { kind: 'draft', message, refused: null })
        void this.settle()
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

  /** Whether this device's file holds the message as it reads now, with words or a picture in it. An edit makes it false until its write lands. */
  saved = () => {
    const outbox = this.#outbox
    if (outbox.kind === 'loading' || outbox.kind === 'broken' || outbox.message !== this.#written) return false
    return outbox.message.text !== '' || outbox.message.pictures.length > 0
  }

  #set(outbox: Outbox) {
    this.#outbox = outbox
    this.#tell()
  }

  #tell() {
    for (const heard of this.#heard) heard()
  }

  /** Writes the draft now, in place of any text save still waiting. */
  flush = () => {
    clearTimeout(this.#saving)
    this.#saving = undefined
    const outbox = this.#outbox
    if (outbox.kind === 'draft') this.#write(outbox.message, null)
    if (outbox.kind === 'unconfirmed' || outbox.kind === 'checking') this.#write(outbox.message, outbox.rev)
  }

  #write(message: Message, rev: number | null) {
    this.#save(message, rev).catch((err) => {
      const outbox = this.#outbox
      if (outbox.kind === 'draft') this.#set({ ...outbox, refused: errorText(err) })
    })
  }

  /** Writes `message`, sent as `rev` or not sent, to the device file after every write before it. Rejects once the sender is closed. */
  #save(message: Message, rev: number | null): Promise<void> {
    const saved = this.#writes.then(async () => {
      if (this.#closed) throw new Error(FORGOT)
      await deviceDrafts.save(this.project, { ...message, sent: rev === null ? null : { rev } })
      this.#written = message
      this.#tell()
    })
    // The next write waits for this one whether it lands or not. Its caller hears how it went.
    this.#writes = saved.catch(() => {})
    return saved
  }

  /**
   * Stops every later write, save, send, and settle, as when the device forgets its computer, and resolves once the
   * last write already under way is done, so the drafts can be cleared after it.
   */
  close(): Promise<unknown> {
    this.#closed = true
    clearTimeout(this.#saving)
    return this.#writes
  }

  link(link: Link) {
    this.#link = link
    if (link === 'connected') void this.settle()
  }

  #edit(message: Message) {
    if (this.#outbox.kind !== 'draft') return
    this.#set({ kind: 'draft', message, refused: null })
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
   * Sends the draft. The computer saves it as a new revision, and the device saves that revision before the send goes,
   * so a send whose answer is lost, even across a relaunch, is settled by its revision and never sent as a second job.
   */
  async send() {
    const outbox = this.#outbox
    if (!canSend(this.#link, outbox) || outbox.kind !== 'draft') return
    const { message } = outbox
    clearTimeout(this.#saving)
    this.#set({ kind: 'sending', message })
    let rev: number
    try {
      // The words as typed reach the device first, so a computer that never answers loses none of them.
      await this.#save(message, null)
      if (this.#closed) throw new Error(FORGOT)
      rev = await saveDraft(this.#chat, message)
      await this.#save(message, rev)
    } catch (err) {
      // No send went out, so the draft stays as it was.
      this.#set({ kind: 'draft', message, refused: errorText(err) })
      this.flush()
      return
    }
    if (this.#closed) return
    try {
      await sendDraft(this.#chat, this.project, rev)
    } catch (err) {
      if (err instanceof Refused) {
        // Refused before it committed, so this revision never goes out, and the next send saves the draft again.
        this.#set({ kind: 'draft', message, refused: errorText(err) })
        this.flush()
        return
      }
      this.#set({ kind: 'unconfirmed', message, rev, refused: errorText(err) })
      return this.settle()
    }
    this.#done()
  }

  #done() {
    this.#set({ kind: 'draft', message: EMPTY, refused: null })
    this.flush()
    this.#sent()
  }

  /**
   * Asks the computer for its final word on the unconfirmed send, while the link is up. A settle that gets no answer
   * leaves the send unconfirmed until the link comes up again or the person checks again.
   */
  settle = async () => {
    const outbox = this.#outbox
    if (this.#closed || outbox.kind !== 'unconfirmed' || this.#link !== 'connected') return
    const { message, rev, refused } = outbox
    this.#set({ kind: 'checking', message, rev, refused })
    let accepted: boolean
    try {
      accepted = await settleSend(this.#chat, rev)
    } catch (err) {
      this.#set({ kind: 'unconfirmed', message, rev, refused: errorText(err) })
      return
    }
    if (accepted) return this.#done()
    // The computer retired the revision, so the draft comes back, and the next send saves it as a new one.
    this.#set({ kind: 'draft', message, refused })
    this.flush()
  }
}
