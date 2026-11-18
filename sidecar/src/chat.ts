/**
 * Chats: one Pi conversation per project. A send commits the message, the settings its turn runs with, and the
 * removal of the draft that holds the message together. A turn that stops before its answer waits with the fix named,
 * and continues once it is fixed. The window sees committed entries only.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { awaitWithContext, BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ImageContent, Models, TextContent } from '@earendil-works/pi-ai'
import {
  type Conversation,
  ConversationBusy,
  type ConversationId,
  configure,
  defineDoc,
  type EntryRecord,
  type Extension,
  LiveDoc,
  type RunFailure,
  type ToolRegistration,
  type Tx,
  type WatchHandle,
} from '@earendil-works/pi-durable'
import type { ConversationView } from '@earendil-works/pi-durable'
import { leaves, WORKFLOW, WORKFLOW_VERSION } from './agent'
import type { Busy } from './busy'
import { type SentMessage, UserMessage } from './entries'
import { folderSummary } from './folder'
import { copyAttachments } from './pictures'
import {
  ASTRA,
  type ChatEntry,
  type ChatView,
  DEFAULT_PROVIDER,
  type Project,
  type ProjectStatus,
  type SidecarEvent,
  START,
  type Turn,
  type Waiting,
} from './protocol'
import { isLoginFailure } from './inference'
import { sendName, type Store } from './store'
import { chatEntry } from './transcript'

const context: Context = BACKGROUND_CONTEXT

/** What a project's current turn runs with, frozen in the commit that sent it. */
const TurnDoc = defineDoc<{ turn: Turn | null }>({
  kind: 'm3d.turn',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ turn: null }),
  checkpointWhen: () => true,
})

/**
 * Why a project's turn waits, and the run failure that was read, so one failure is read once. `tool` marks a wait a
 * running tool holds, such as Astra's for a sign-in: the tool goes on by itself, so nothing continues the run. Cleared
 * in the commit that sends, retries, or resumes, or by the tool once its wait ends. `saves` is how many times the
 * turn's provider login was saved when the turn last went out, so a refusal can tell a login saved since then.
 */
const WaitingDoc = defineDoc<{ waiting: Waiting | null; failure: number | null; tool: boolean; saves: number | null }>({
  kind: 'm3d.waiting',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ waiting: null, failure: null, tool: false, saves: null }),
  checkpointWhen: () => true,
})

/**
 * The one writer of a chat's waiting record: why its turn waits now, or null. The wait is the turn's own unless `tool`
 * says a running tool holds it, so every other write lets go a wait a tool held. `kept` leaves that mark as it was,
 * which only a turn that goes on asks for. `failure` and `saves` change only when given.
 */
async function wait(
  tx: Tx,
  conversation: ConversationId,
  waiting: Waiting | null,
  { tool = false, failure, saves }: { tool?: boolean | 'kept'; failure?: number; saves?: number | undefined } = {},
): Promise<void> {
  const record = await tx.doc(WaitingDoc, conversation)
  record.waiting = waiting
  if (tool !== 'kept') record.tool = tool
  if (failure !== undefined) record.failure = failure
  if (saves !== undefined) record.saves = saves
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
/** Attachments that go to the model as pictures. Every other file goes as its path in the message. */
const PICTURE = /\.(png|jpe?g|gif|webp|heic|heif)$/i
/** Models read pictures up to about 5 MB. Larger ones, and HEIC photos, go as a smaller JPEG on macOS. */
const MAX_IMAGE_BYTES = 3_500_000

export interface ChatsOptions {
  store: Store
  models: Models
  extension: Extension
  tools: readonly ToolRegistration[]
  version: string
  busy: Busy
  emit(event: SidecarEvent): void
}

/**
 * A path the window named for an attachment: a regular file inside the project folder where it really leads, links
 * followed. Anything else, such as a pipe that would hold every read, is refused.
 */
function inside(folder: string, rel: string): string {
  const path = join(folder, rel)
  const back = relative(realpathSync.native(folder), realpathSync.native(path))
  if (back === '' || leaves(back) || !statSync(path).isFile()) throw new Error(`${rel} is not a file in the project folder`)
  return path
}

/** A picture the model can read: as it is, or on macOS as a JPEG made with `sips`. Undefined when neither works. */
function picture(folder: string, rel: string): ImageContent | undefined {
  const path = inside(folder, rel)
  const type = IMAGE_TYPES[extname(rel).toLowerCase()]
  if (type !== undefined && statSync(path).size <= MAX_IMAGE_BYTES) {
    return { type: 'image', data: readFileSync(path).toString('base64'), mimeType: type }
  }
  if (process.platform !== 'darwin') return undefined
  // The JPEG is made in a folder of its own outside the project, so no link in the project can steer where it is written.
  const scratch = mkdtempSync(join(tmpdir(), 'm3d-send-'))
  try {
    const out = join(scratch, 'picture.jpg')
    const converted = Bun.spawnSync(['sips', '-s', 'format', 'jpeg', '-Z', '2000', path, '--out', out])
    if (converted.exitCode !== 0) return undefined
    return { type: 'image', data: readFileSync(out).toString('base64'), mimeType: 'image/jpeg' }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * The message the model reads: the text, a note naming where each attachment is saved, and each picture as a picture.
 * A file that is not a picture, such as a PDF, 3MF, or STL, goes by its path only, for the agent to open itself. So does
 * a picture the model cannot read, such as a HEIC photo that could not be made a JPEG.
 */
function userContent(
  folder: string,
  text: string,
  attachments: string[],
): { content: string | (TextContent | ImageContent)[]; shown: string[]; named: string[] } {
  const read = attachments.filter((rel) => PICTURE.test(rel)).map((rel) => ({ rel, image: picture(folder, rel) }))
  const shown = read.flatMap(({ rel, image }) => (image === undefined ? [] : [rel]))
  const named = [
    ...attachments.filter((rel) => !PICTURE.test(rel)),
    ...read.flatMap(({ rel, image }) => (image === undefined ? [rel] : [])),
  ]
  let note = ''
  if (shown.length > 0) note += `\n\n(Pictures attached, saved in this folder as: ${shown.join(', ')})`
  if (named.length > 0) note += `\n\n(Files attached, saved in this folder as: ${named.join(', ')})`
  const content = note === '' ? text : [{ type: 'text' as const, text: `${text}${note}` }, ...read.flatMap(({ image }) => image ?? [])]
  return { content, shown, named }
}

/** A chat's state as one read found it, and that read's place in the order of reads. */
type State = { running: boolean; waiting: Waiting | null; turn: Turn | null; failure: RunFailure | undefined; seq: number }

/** What the window sees of a chat. Every view and `chat` event is made here. */
const view = (project: string, entries: ChatEntry[], { running, waiting, turn, seq }: State): ChatView => ({ project, entries, running, waiting, turn, seq })

export class Chats {
  readonly #o: ChatsOptions
  readonly #watches = new Map<string, WatchHandle<ConversationView>>()
  /** The newest entry each watched chat has sent the window. */
  readonly #sent = new Map<string, number>()
  #seq = 0
  /** Tools waiting for a sign-in, by provider. */
  readonly #signIns = new Map<string, Set<() => void>>()

  constructor(options: ChatsOptions) {
    this.#o = options
  }

  async #conversation(project: string): Promise<Conversation> {
    return this.#conversationOf(await this.#o.store.project(project))
  }

  async #conversationOf(project: Project): Promise<Conversation> {
    const found = await this.#o.store.harness.conversation(project.conversation as ConversationId, context)
    if (found === undefined) throw new Error(`project ${project.id} has no conversation`)
    return found
  }

  async #entries(conversation: Conversation, after = 0): Promise<ChatEntry[]> {
    const entries: ChatEntry[] = []
    let cursor: Parameters<Conversation['entries']>[2]
    do {
      const page = await conversation.entries({ order: 'ascending', minEntryId: (after + 1) as EntryRecord['id'] }, 500, cursor, context)
      entries.push(...page.items.flatMap((entry) => chatEntry(entry) ?? []))
      cursor = page.next
    } while (cursor !== undefined)
    return entries
  }

  /**
   * A chat's state, with its order taken at once, before anything else is awaited, so a `chat.open` that reads
   * between two reads is ordered by when it read too.
   */
  async #state(conversation: Conversation): Promise<State> {
    const { harness } = this.#o.store
    const [live, waiting, turn] = await Promise.all([
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(WaitingDoc, conversation.id, context),
      harness.snapshot(TurnDoc, conversation.id, context),
    ])
    return { running: live?.run !== undefined, waiting: waiting?.waiting ?? null, turn: turn?.turn ?? null, failure: live?.runFailure, seq: this.#nextSeq() }
  }

  /** The whole chat, and from now on its changes as `chat` events. */
  async open(project: string): Promise<ChatView> {
    const conversation = await this.#conversation(project)
    await this.#watch(project, conversation)
    const entries = await this.#entries(conversation)
    this.#sent.set(project, Math.max(this.#sent.get(project) ?? 0, entries.at(-1)?.id ?? 0))
    return view(project, entries, await this.#state(conversation))
  }

  async #watch(project: string, conversation: Conversation): Promise<void> {
    if (this.#watches.has(project)) return
    const watch = await conversation.watch(context)
    this.#watches.set(project, watch)
    watch.start(async (call) => {
      if (call.kind === 'value') await this.#changed(project, conversation)
    })
  }

  /**
   * The order of a read of a chat's state. It grows across sidecar runs too: a sidecar that starts again after a crash
   * reads after the one before it, so the window, which still holds that one's views, takes the new run's views. It
   * starts from the clock in microseconds, and each read is after the last.
   */
  #nextSeq(): number {
    this.#seq = Math.max(this.#seq + 1, Date.now() * 1000)
    return this.#seq
  }

  async #changed(project: string, conversation: Conversation): Promise<void> {
    let state = await this.#state(conversation)
    const failure = await this.#unread(conversation, state)
    if (failure !== undefined) {
      // The waiting document is not part of the view a watch follows, so its commit wakes no one: read it here.
      // A login saved since the turn went out lets it go on now: the sign-in that saved it found no wait to let go.
      if (await this.#read(conversation, failure, state.turn)) this.#resume(project, failure.taskId)
      state = await this.#state(conversation)
    }
    const entries = await this.#entries(conversation, this.#sent.get(project) ?? 0)
    if (entries.length > 0) this.#sent.set(project, entries.at(-1)?.id ?? 0)
    this.#o.emit({ type: 'chat', ...view(project, entries, state) })
  }

  /** The run failure in `state` that no read has recorded yet. A stop is the person's own, so it needs no read. */
  async #unread(conversation: Conversation, { failure }: State): Promise<RunFailure | undefined> {
    const recorded = (await this.#o.store.harness.snapshot(WaitingDoc, conversation.id, context))?.failure ?? null
    return failure !== undefined && failure.reason !== 'aborted' && failure.taskId !== recorded ? failure : undefined
  }

  /** Whether `turn` started on another version of the app. */
  #fromOtherVersion(turn: Turn | null): boolean {
    return turn !== null && turn.app !== this.#o.version
  }

  /**
   * Reads why a run stopped: a provider with no login, or a refused one, waits for a sign-in; anything else for a retry.
   * Resolves true when the login was missing or refused but a newer one was saved since the turn went out, so the
   * wait can be let go at once. The login read here may be older than that save, so only the save count, read in the
   * commit, decides. A turn from another version of the app is left to wait.
   */
  async #read(conversation: Conversation, failure: RunFailure, turn: Turn | null): Promise<boolean> {
    const { models, store } = this.#o
    const provider = turn?.model.provider ?? DEFAULT_PROVIDER
    const name = models.getProvider(provider)?.name ?? provider
    const auth = await models.getAuth(provider).catch(() => undefined)
    const detail = typeof failure.detail === 'string' ? failure.detail : failure.reason
    const login = auth === undefined || (failure.reason === 'model_error' && isLoginFailure(detail))
    const waiting: Waiting =
      login
        ? { kind: 'login', provider, name, fix: `Sign in to ${name}. The message picks up where it stopped.` }
        : { kind: 'error', detail, fix: 'Try again' }
    return store.harness.commit(async (tx) => {
      // A send that came after this failure started a new turn, which this failure must not hold.
      if ((await tx.doc(TurnDoc, conversation.id)).turn?.requestId !== turn?.requestId) return false
      await wait(tx, conversation.id, waiting, { failure: failure.taskId })
      const sent = (await tx.doc(WaitingDoc, conversation.id)).saves
      // Read in this commit, so a sign-in either lands before it and is seen here, or after it and finds this wait.
      const saves = await store.loginSavesIn(tx, provider)
      return login && sent !== null && saves > sent && turn !== null && !this.#fromOtherVersion(turn)
    }, context)
  }

  /**
   * Sends the draft saved as revision `rev` under `key`, a project id or `START`, and answers the project it went to.
   * Each step is safe to run again after a crash or a lost answer: the project a start screen revision made is found,
   * not made again, a message already committed as `draft-<rev>` is not sent again, and the files are copied once.
   * The message, the settings its turn runs with, and the removal of the draft commit together. Only that revision's
   * content goes out. A draft saved after it is the next message and stays, even one that reads the same.
   */
  async send(key: string, rev: number): Promise<Project> {
    const { store, extension, tools, version, busy } = this.#o
    // A start screen send goes out as the draft its project took, even if the project's draft changed since, as after a
    // crash before the message. A project's own send goes out as its draft, only while that is still this revision.
    const started = key === START ? await store.startProject(rev) : undefined
    const project = started?.project ?? (await store.project(key))
    const conversation = await this.#conversation(project.id)
    const requestId = sendName(rev)
    if ((await store.harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context)) !== undefined) {
      await this.#watch(project.id, conversation)
      return project
    }
    const draft = started?.draft ?? (await store.draft(project.id, rev))
    const folder = store.projectFolder(project.id)
    const attachments = await copyAttachments(folder, rev, draft.attachments)
    // The chat entry keeps the split the model got: a picture it could not read is shown as a file, by its path.
    const { content, shown, named } = userContent(folder, draft.text, attachments)
    try {
      await busy.during(() => store.harness.commit(async (tx) => {
        if ((await tx.submissionByRequest(conversation.id, requestId)) !== undefined) return
        const { model, thinking, astra, saves } = await store.send(tx, project.id, rev)
        const offered = astra ? tools : tools.filter((tool) => tool.name !== ASTRA)
        await conversation.submit(tx, {
          type: 'input',
          content,
          requestId,
          whenBusy: 'reject',
          entry: { kind: UserMessage.kind, data: { text: draft.text, images: shown, files: named } satisfies SentMessage },
        })
        await configure(tx, conversation.id, { model, thinkingLevel: thinking, extensions: [extension], tools: offered, instructions: WORKFLOW, cwd: folder })
        const turn: Turn = { requestId, model, thinking, tools: offered.map((t) => t.name), instructions: WORKFLOW_VERSION, app: version, startedMs: Date.now() }
        ;(await tx.doc(TurnDoc, conversation.id)).turn = turn
        await wait(tx, conversation.id, null, { saves })
      }, context))
    } catch (error) {
      if (error instanceof ConversationBusy) throw new Error('The agent is still working on the last message.')
      throw error
    }
    await this.#watch(project.id, conversation)
    return project
  }

  /**
   * Goes on from where the turn stopped, with the model, tools, and instructions it started with, and clears what it
   * waited on. The turn records the app version that goes on with it. With `login`, the run failure a sign-in wait was
   * recorded for, it goes on only while the turn still waits on that one, so when two paths let one wait go, as a
   * sign-in and the read of a failure that crossed it, the turn goes on once, and a late one never lets go a newer
   * wait from the same refused login. Such a turn goes on by itself, so it waits for the pass while an update
   * installs, instead of failing and being left waiting when the install fails.
   */
  async #continue(project: string, login?: number): Promise<void> {
    const { store, version } = this.#o
    const conversation = await this.#conversation(project)
    const commit = () =>
      store.harness.commit(async (tx) => {
        const waiting = await tx.doc(WaitingDoc, conversation.id)
        if (login !== undefined && (waiting.waiting?.kind !== 'login' || waiting.failure !== login)) return
        await conversation.submit(tx, { type: 'continue' })
        const { turn } = await tx.doc(TurnDoc, conversation.id)
        if (turn !== null) turn.app = version
        const saves = turn === null ? undefined : await store.loginSavesIn(tx, turn.model.provider)
        await wait(tx, conversation.id, null, { tool: 'kept', saves })
      }, context)
    if (login === undefined) await this.#o.busy.during(commit)
    else await this.#o.busy.duringWhenAllowed(commit)
    await this.#watch(project, conversation)
  }

  /**
   * Lets a sign-in wait go, in the background: it may wait out an installing update, which must not hold up the chat's
   * other changes, the start, or a quit. The wait stays recorded until the turn goes on, so a failure here leaves the
   * fix shown.
   */
  #resume(project: string, login: number): void {
    this.#continue(project, login).catch((error: unknown) => console.error(`going on after a sign-in failed: ${String(error)}`))
  }

  /**
   * Resolves once the person is signed in to `provider`, for a running tool: with `after`, signed in with a login saved
   * after that many saves, as the one then saved was refused. Until then it holds the turn where it is, with the fix
   * named on its chat, and goes on once they sign in. A stop ends the wait. A wait the tool held before a restart is
   * let go once the sign-in is there.
   */
  async loginFor(conversation: number, task: string, provider: string, waiting: Context, after: number | undefined): Promise<void> {
    const { models, store } = this.#o
    const id = conversation as ConversationId
    const name = models.getProvider(provider)?.name ?? provider
    const project = await store.projectOf(conversation)
    const hold = (waiting: Waiting | null) => store.harness.commit((tx) => wait(tx, id, waiting, { tool: waiting !== null }), context)
    const ready = async () =>
      after === undefined ? (await models.getAuth(provider).catch(() => undefined)) !== undefined : (await store.loginSaves(provider)) > after
    const fix =
      after === undefined ? `Sign in to ${name}. Astra picks up where it stopped.` : `${name} refused the saved sign-in. Sign in again. Astra picks up where it stopped.`
    let held = (await store.harness.snapshot(WaitingDoc, id, context))?.tool ?? false
    try {
      for (;;) {
        // The waiter is in place before the check, so a sign-in that lands between the two is not missed.
        const { promise, resolve } = Promise.withResolvers<void>()
        const waiters = this.#signIns.get(provider) ?? new Set()
        this.#signIns.set(provider, waiters.add(resolve))
        try {
          if (await ready()) return
          if (!held) {
            held = true
            await hold({ kind: 'login', provider, name, fix })
            await this.#show(project)
          }
          await this.#o.busy.parked(task, () => awaitWithContext(promise, waiting), waiting.abortSignal)
        } finally {
          waiters.delete(resolve)
        }
      }
    } finally {
      if (held) {
        await hold(null)
        await this.#show(project)
      }
    }
  }

  /** Sends the window a chat's state, for a change its watch does not see. */
  async #show(project: string): Promise<void> {
    await this.#changed(project, await this.#conversation(project))
  }

  /** Each project's status for the sidebar, by project id. */
  async status(): Promise<Record<string, ProjectStatus>> {
    const { store } = this.#o
    const rows = await Promise.all(
      (await store.projects()).map(async (project) => {
        const { running, turn } = await this.#state(await this.#conversationOf(project))
        const { printFiles, newestMs } = folderSummary(join(store.projectsDir, project.id))
        const lastMs = Math.max(project.createdMs, turn?.startedMs ?? 0, newestMs)
        return [project.id, { running, printed: project.printed === true, printFiles, lastMs }] as const
      }),
    )
    return Object.fromEntries(rows)
  }

  async retry(project: string): Promise<void> {
    await this.#continue(project)
  }

  async tools(project: string): Promise<string[]> {
    const agent = await (await this.#conversation(project)).agent(context)
    return agent.tools.map((tool) => tool.name)
  }

  /** Stops the turn. What it waited on is forgotten, so a later sign-in does not start it again. */
  async stop(project: string): Promise<void> {
    const conversation = await this.#conversation(project)
    await conversation.abort(context)
    await this.#o.store.harness.commit((tx) => wait(tx, conversation.id, null), context)
    await this.#show(project)
  }

  /** A turn that started on another version of the app waits for the person to go on with this one. */
  async #outdated(conversation: ConversationId): Promise<void> {
    const waiting: Waiting = { kind: 'error', detail: `Materialize 3D was updated to ${this.#o.version} while this turn ran.`, fix: 'Go on' }
    await this.#o.store.harness.commit((tx) => wait(tx, conversation, waiting), context)
  }

  /**
   * After a sign-in: every tool and every turn that waited on that provider goes on, except a turn that started on
   * another version of the app, which waits for the person to go on with this one.
   */
  async signedIn(provider: string): Promise<void> {
    const { store } = this.#o
    for (const resolve of this.#signIns.get(provider) ?? []) resolve()
    for (const project of await store.projects()) {
      const conversation = project.conversation as ConversationId
      const waiting = await store.harness.snapshot(WaitingDoc, conversation, context)
      if (waiting?.waiting?.kind !== 'login' || waiting.waiting.provider !== provider || waiting.tool) continue
      const turn = (await store.harness.snapshot(TurnDoc, conversation, context))?.turn ?? null
      if (this.#fromOtherVersion(turn)) {
        await this.#outdated(conversation)
        await this.#show(project.id)
      } else if (waiting.failure !== null) {
        this.#resume(project.id, waiting.failure)
      }
    }
  }

  /**
   * At start: a turn that ran on another version of the app stops, waiting for the person to go on with this one,
   * instead of going on with code it did not start with. Then runs a crash cut off go on from their last committed
   * step, every chat is watched, failures not yet read are read, and turns that waited on a login that is now there
   * go on.
   */
  async reconcile(): Promise<void> {
    const { store } = this.#o
    const projects = await store.projects()
    const outdated: Conversation[] = []
    for (const project of projects) {
      const conversation = await this.#conversation(project.id)
      const { running, turn } = await this.#state(conversation)
      if (running && this.#fromOtherVersion(turn)) outdated.push(conversation)
    }
    await Promise.all(
      outdated.map(async (conversation) => {
        await conversation.abort(context)
        await this.#outdated(conversation.id)
      }),
    )
    store.harness.resume()
    for (const project of projects) {
      const conversation = await this.#conversation(project.id)
      await this.#watch(project.id, conversation)
      const state = await this.#state(conversation)
      const failure = await this.#unread(conversation, state)
      if (failure !== undefined) await this.#read(conversation, failure, state.turn)
      const record = await store.harness.snapshot(WaitingDoc, conversation.id, context)
      const running = (await this.#state(conversation)).running
      if (record?.tool && !running) {
        // A tool held this wait, and its run is gone: nothing will let it go but this.
        await store.harness.commit((tx) => wait(tx, conversation.id, null), context)
        continue
      }
      if (record === undefined || record.waiting?.kind !== 'login' || record.tool || running) continue
      const waiting = record.waiting
      if (this.#fromOtherVersion(state.turn)) await this.#outdated(conversation.id)
      else if (record.failure !== null && (await this.#savedSince(record, waiting.provider))) this.#resume(project.id, record.failure)
    }
    // The window may have read a chat before this, and what was set right here, such as a wait, reaches no watch. So
    // each chat's state as reconciled goes to the window, an idle chat's too.
    for (const project of projects) {
      const conversation = await this.#conversation(project.id)
      this.#o.emit({ type: 'chat', ...view(project.id, [], await this.#state(conversation)) })
    }
  }

  /**
   * Whether a login the turn did not go out with is there: one saved since it last went out, as a sign-in that a crash
   * cut off before it let the turn go. The login it went out with was missing or refused, so trying it again cannot help.
   */
  async #savedSince(record: { saves: number | null }, provider: string): Promise<boolean> {
    if (record.saves !== null) return (await this.#o.store.loginSaves(provider)) > record.saves
    return (await this.#o.models.getAuth(provider).catch(() => undefined)) !== undefined
  }

  async close(): Promise<void> {
    await Promise.all([...this.#watches.values()].map((watch) => watch.stop()))
  }
}
