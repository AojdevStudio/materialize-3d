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
 *   `reading` counts the pictures picked for it that are still being read, and it sends only once none is.
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
  | { kind: 'draft'; message: Message; refused: string | null; reading: number }
  | { kind: 'sending'; message: Message }
  | { kind: 'unconfirmed'; message: Message; rev: number; refused: string | null }
  | { kind: 'checking'; message: Message; rev: number; refused: string | null }

const EMPTY: Message = { text: '', pictures: [] }

const draft = (message: Message, refused: string | null = null): Outbox => ({ kind: 'draft', message, refused, reading: 0 })

/** Text saves wait this long after the last key, so typing writes the file once. */
const SAVE_AFTER_MS = 400

const FORGOT = 'This device forgot the computer, so the draft was not kept.'

/** Whether the draft can go out now. `running` is whether the chat's last view says the agent still works on a turn. */
export const canSend = (link: Link, outbox: Outbox, running: boolean) =>
  link === 'connected' &&
  !running &&
  outbox.kind === 'draft' &&
  outbox.reading === 0 &&
  (outbox.message.text.trim() !== '' || outbox.message.pictures.length > 0)

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
  /**
   * Network work, and the device writes queued while Forget runs, wait on this. It is settled except during Forget:
   * `pause` makes a new one, a Forget that fails resolves it, and one that works rejects it.
   */
  #gate: Promise<void> = Promise.resolve()
  #lift: ((forgot: boolean) => void) | null = null
  /**
   * Whether the chat's last view says the agent still works on a turn, so a send would be refused. It outlives the chat
   * screen, so a chat opened again keeps Send off until a newer view says the turn ended.
   */
  #running = false
  /** The `seq` of the view `#running` came from. */
  #runningSeq = -1
  /** How many of the chat's events this sender has heard, so a whole read can tell whether one came while it ran. */
  #events = 0
  /** Set when the link comes up again while a settle is under way. */
  #relinked = false
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
        this.#set(saved?.sent ? { kind: 'unconfirmed', message, rev: saved.sent.rev, refused: null } : draft(message))
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
    const gate = this.#gate
    const saved = this.#writes.then(async () => {
      await gate
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
   * Holds back every save, send, and settle, and every device write after the ones already queued, as when the device
   * starts to forget its computer. A text save still waiting is queued first. Resolves once the queued writes landed,
   * so Rust can clear the drafts after them.
   */
  pause(): Promise<unknown> {
    if (this.#saving !== undefined) this.flush()
    if (this.#lift === null) {
      this.#gate = new Promise((resolve, reject) => {
        this.#lift = (forgot) => (forgot ? reject(new Error(FORGOT)) : resolve())
      })
      // Only the work held behind it hears a Forget that worked.
      this.#gate.catch(() => {})
    }
    return this.#writes
  }

  /** Lets go what `pause` held, after a Forget that failed, with the message as it was. */
  resume() {
    this.#lift?.(false)
    this.#lift = null
    this.#gate = Promise.resolve()
    void this.settle()
  }

  /** Drops what `pause` held, and stops every later write, save, send, and settle, once the device forgot its computer after `pause`. */
  close() {
    this.#closed = true
    clearTimeout(this.#saving)
    this.#lift?.(true)
  }

  running = () => this.#running

  /** Takes whether the chat's turn runs from an event, unless a newer one (by `seq`) already said. */
  setRunning(running: boolean, seq: number) {
    this.#events++
    if (seq < this.#runningSeq) return
    this.#take(running, seq)
  }

  /** Marks the start of a whole read of the chat, for `readRunning`. */
  reading = () => this.#events

  /**
   * Takes whether the chat's turn runs from a whole read that started at `mark`. With no event since it started, the read
   * is the computer's newest word, so it counts even with a lower `seq`, as after a restart. After an event, it counts
   * only when newer.
   */
  readRunning(running: boolean, seq: number, mark: number) {
    if (this.#events !== mark && seq < this.#runningSeq) return
    this.#take(running, seq)
  }

  #take(running: boolean, seq: number) {
    this.#runningSeq = seq
    if (this.#running === running) return
    this.#running = running
    this.#tell()
  }

  link(link: Link) {
    this.#link = link
    if (link !== 'connected') return
    // A settle already under way may have gone out on the link that just dropped, so it asks again if it fails.
    if (this.#outbox.kind === 'checking') this.#relinked = true
    else void this.settle()
  }

  #edit(message: Message) {
    if (this.#outbox.kind !== 'draft') return
    this.#set({ ...this.#outbox, message, refused: null })
  }

  write(text: string) {
    if (this.#outbox.kind !== 'draft') return
    this.#edit({ ...this.#outbox.message, text })
    clearTimeout(this.#saving)
    this.#saving = setTimeout(this.flush, SAVE_AFTER_MS)
  }

  /** Adds the picture `read` gives once it is read, and keeps the draft from going out until then. */
  async addPicture(read: Promise<Picture>) {
    if (this.#outbox.kind !== 'draft') return
    this.#set({ ...this.#outbox, reading: this.#outbox.reading + 1 })
    const picked = await read.then(
      (picture) => ({ picture }),
      (err: unknown) => ({ refused: errorText(err) }),
    )
    // A draft with a picture still reading cannot send, so it is still a draft.
    const outbox = this.#outbox
    if (outbox.kind !== 'draft') return
    const reading = outbox.reading - 1
    if ('refused' in picked) return this.#set({ ...outbox, refused: picked.refused, reading })
    this.#set({ kind: 'draft', message: { ...outbox.message, pictures: [...outbox.message.pictures, picked.picture] }, refused: null, reading })
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
    if (!canSend(this.#link, outbox, this.#running) || outbox.kind !== 'draft') return
    const { message } = outbox
    clearTimeout(this.#saving)
    this.#set({ kind: 'sending', message })
    let rev: number
    try {
      // The words as typed reach the device first, so a computer that never answers loses none of them.
      await this.#save(message, null)
      await this.#gate
      rev = await saveDraft(this.#chat, message)
      await this.#save(message, rev)
      await this.#gate
    } catch (err) {
      // No send went out, so the draft stays as it was.
      this.#set(draft(message, errorText(err)))
      this.flush()
      return
    }
    try {
      await sendDraft(this.#chat, this.project, rev)
    } catch (err) {
      if (err instanceof Refused) {
        // Refused before it committed, so this revision never goes out, and the next send saves the draft again.
        this.#set(draft(message, errorText(err)))
        this.flush()
        return
      }
      this.#set({ kind: 'unconfirmed', message, rev, refused: errorText(err) })
      return this.settle()
    }
    this.#done()
  }

  #done() {
    this.#set(draft(EMPTY))
    this.flush()
    this.#sent()
  }

  /**
   * Asks the computer for its final word on the unconfirmed send, while the link is up. A settle that gets no answer
   * leaves the send unconfirmed until the link comes up again or the person checks again.
   */
  settle = async (): Promise<void> => {
    const outbox = this.#outbox
    if (this.#lift !== null || this.#closed || outbox.kind !== 'unconfirmed' || this.#link !== 'connected') return
    const { message, rev, refused } = outbox
    this.#relinked = false
    this.#set({ kind: 'checking', message, rev, refused })
    let accepted: boolean
    try {
      accepted = await settleSend(this.#chat, rev)
    } catch (err) {
      this.#set({ kind: 'unconfirmed', message, rev, refused: errorText(err) })
      if (this.#relinked) return this.settle()
      return
    }
    if (accepted) return this.#done()
    // The computer retired the revision, so the draft comes back, and the next send saves it as a new one.
    this.#set(draft(message, refused))
    this.flush()
  }
}
