/**
 * Chats: one Pi conversation per project. A send commits the message, the settings its turn runs with, and the
 * removal of the draft that holds the message together. A turn that stops before its answer waits with the fix named,
 * and continues once it is fixed. The window sees committed entries only.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { awaitWithContext, BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ImageContent, Models, TextContent } from '@earendil-works/pi-ai'
import {
  type Conversation,
  ConversationBusy,
  type ConversationId,
  configure,
  type EntryRecord,
  type Extension,
  LiveDoc,
  type RunFailure,
  type ToolRegistration,
  type WatchHandle,
} from '@earendil-works/pi-durable'
import type { ConversationView } from '@earendil-works/pi-durable'
import { leaves, WORKFLOW, WORKFLOW_VERSION } from './agent'
import type { Busy } from './busy'
import type { ChatEntry, ChatView, SidecarEvent, Turn, Waiting } from './protocol'
import { isLoginFailure } from './inference'
import { DraftsDoc, LoginSavesDoc, SettingsDoc, type Store, TurnDoc, WaitingDoc } from './store'
import { chatEntry } from './transcript'

const context: Context = BACKGROUND_CONTEXT

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
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

function userContent(folder: string, text: string, attachments: string[]): string | (TextContent | ImageContent)[] {
  if (attachments.length === 0) return text
  const images = attachments.flatMap((rel) => picture(folder, rel) ?? [])
  const note = `\n\n(Pictures attached, saved in this folder as: ${attachments.join(', ')})`
  return [{ type: 'text', text: `${text}${note}` }, ...images]
}

export class Chats {
  readonly #o: ChatsOptions
  readonly #watches = new Map<string, WatchHandle<ConversationView>>()
  /** The newest entry each watched chat has sent the window. */
  readonly #sent = new Map<string, number>()
  /** Counts reads of a chat's state, in the order they were read, for `ChatView.seq`. */
  #seq = 0
  /** Tools waiting for a sign-in, by provider. */
  readonly #signIns = new Map<string, Set<() => void>>()

  constructor(options: ChatsOptions) {
    this.#o = options
  }

  async #conversation(project: string): Promise<Conversation> {
    const { conversation } = await this.#o.store.project(project)
    const found = await this.#o.store.harness.conversation(conversation as ConversationId, context)
    if (found === undefined) throw new Error(`project ${project} has no conversation`)
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

  async #state(conversation: Conversation): Promise<{ running: boolean; waiting: Waiting | null; turn: Turn | null; failure: RunFailure | undefined }> {
    const { harness } = this.#o.store
    const [live, waiting, turn] = await Promise.all([
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(WaitingDoc, conversation.id, context),
      harness.snapshot(TurnDoc, conversation.id, context),
    ])
    return { running: live?.run !== undefined, waiting: waiting?.waiting ?? null, turn: turn?.turn ?? null, failure: live?.runFailure }
  }

  /** The whole chat, and from now on its changes as `chat` events. */
  async open(project: string): Promise<ChatView> {
    const conversation = await this.#conversation(project)
    await this.#watch(project, conversation)
    const entries = await this.#entries(conversation)
    this.#sent.set(project, Math.max(this.#sent.get(project) ?? 0, entries.at(-1)?.id ?? 0))
    const { running, waiting, turn } = await this.#state(conversation)
    return { project, entries, running, waiting, turn, seq: ++this.#seq }
  }

  async #watch(project: string, conversation: Conversation): Promise<void> {
    if (this.#watches.has(project)) return
    const watch = await conversation.watch(context)
    this.#watches.set(project, watch)
    watch.start(async (call) => {
      if (call.kind === 'value') await this.#changed(project, conversation)
    })
  }

  async #changed(project: string, conversation: Conversation): Promise<void> {
    let state = await this.#state(conversation)
    const recorded = (await this.#o.store.harness.snapshot(WaitingDoc, conversation.id, context))?.failure ?? null
    if (state.failure !== undefined && state.failure.reason !== 'aborted' && state.failure.taskId !== recorded) {
      // The waiting document is not part of the view a watch follows, so its commit wakes no one: read it here.
      // A login saved since the turn went out lets it go on now: the sign-in that saved it found no wait to let go.
      if (await this.#read(conversation, state.failure, state.turn)) this.#resume(project, state.failure.taskId)
      state = await this.#state(conversation)
    }
    const seq = ++this.#seq
    const entries = await this.#entries(conversation, this.#sent.get(project) ?? 0)
    if (entries.length > 0) this.#sent.set(project, entries.at(-1)?.id ?? 0)
    this.#o.emit({ type: 'chat', project, entries, running: state.running, waiting: state.waiting, turn: state.turn, seq })
  }

  /**
   * Reads why a run stopped: a provider with no login, or a refused one, waits for a sign-in; anything else for a retry.
   * Resolves true when the login was missing or refused but a newer one was saved since the turn went out, so the
   * wait can be let go at once. The login read here may be older than that save, so only the save count, read in the
   * commit, decides. A turn from another version of the app is left to wait.
   */
  async #read(conversation: Conversation, failure: RunFailure, turn: Turn | null): Promise<boolean> {
    const { models, store, version } = this.#o
    const provider = turn?.model.provider ?? 'anthropic'
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
      const record = await tx.doc(WaitingDoc, conversation.id)
      record.failure = failure.taskId
      record.tool = false
      record.waiting = waiting
      // Read in this commit, so a sign-in either lands before it and is seen here, or after it and finds this wait.
      const saves = (await tx.doc(LoginSavesDoc, store.root.id)).saves[provider] ?? 0
      return login && record.saves !== null && saves > record.saves && turn?.app === version
    }, context)
  }

  /**
   * Sends a message. The message, the settings its turn runs with, and the removal of the draft that holds it commit
   * together. A send whose `requestId` was already committed changes nothing, so the window can send again after any
   * failure, even once a picture it sent is gone.
   */
  async send(project: string, requestId: string, text: string, attachments: string[]): Promise<void> {
    const { store, extension, tools, version, busy } = this.#o
    const conversation = await this.#conversation(project)
    if ((await store.harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context)) !== undefined) {
      await this.#watch(project, conversation)
      return
    }
    const folder = store.projectFolder(project)
    const content = userContent(folder, text, attachments)
    try {
      await busy.during(() => store.harness.commit(async (tx) => {
        if ((await tx.submissionByRequest(conversation.id, requestId)) !== undefined) return
        const settings = await tx.doc(SettingsDoc, store.root.id)
        const model = { provider: settings.model.provider, modelId: settings.model.modelId }
        const thinking = settings.thinking
        await conversation.submit(tx, {
          type: 'input',
          content,
          requestId,
          whenBusy: 'reject',
          entry: { kind: 'm3d.user', data: { text, images: attachments } },
        })
        await configure(tx, conversation.id, { model, thinkingLevel: thinking, extensions: [extension], tools, instructions: WORKFLOW, cwd: folder })
        const turn: Turn = { requestId, model, thinking, tools: tools.map((t) => t.name), instructions: WORKFLOW_VERSION, app: version, startedMs: Date.now() }
        ;(await tx.doc(TurnDoc, conversation.id)).turn = turn
        // Text typed after this message was sent is a newer message, so only a draft of this text goes.
        const { drafts } = await tx.doc(DraftsDoc, store.root.id)
        if (drafts[project]?.text.trim() === text.trim()) delete drafts[project]
        const waiting = await tx.doc(WaitingDoc, conversation.id)
        waiting.waiting = null
        waiting.tool = false
        waiting.saves = (await tx.doc(LoginSavesDoc, store.root.id)).saves[model.provider] ?? 0
      }, context))
    } catch (error) {
      if (error instanceof ConversationBusy) throw new Error('The agent is still working on the last message.')
      throw error
    }
    await this.#watch(project, conversation)
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
        waiting.waiting = null
        const { turn } = await tx.doc(TurnDoc, conversation.id)
        if (turn !== null) {
          turn.app = version
          waiting.saves = (await tx.doc(LoginSavesDoc, store.root.id)).saves[turn.model.provider] ?? 0
        }
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
    const hold = (wait: Waiting | null) =>
      store.harness.commit(async (tx) => {
        const record = await tx.doc(WaitingDoc, id)
        record.waiting = wait
        record.tool = wait !== null
      }, context)
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
    await this.#o.store.harness.commit(async (tx) => {
      const record = await tx.doc(WaitingDoc, conversation.id)
      record.waiting = null
      record.tool = false
    }, context)
    await this.#show(project)
  }

  /** A turn that started on another version of the app waits for the person to go on with this one. */
  async #outdated(conversation: ConversationId): Promise<void> {
    await this.#o.store.harness.commit(async (tx) => {
      const record = await tx.doc(WaitingDoc, conversation)
      record.waiting = { kind: 'error', detail: `Materialize 3D was updated to ${this.#o.version} while this turn ran.`, fix: 'Go on' }
      record.tool = false
    }, context)
  }

  /**
   * After a sign-in: every tool and every turn that waited on that provider goes on, except a turn that started on
   * another version of the app, which waits for the person to go on with this one.
   */
  async signedIn(provider: string): Promise<void> {
    const { store, version } = this.#o
    for (const resolve of this.#signIns.get(provider) ?? []) resolve()
    for (const project of await store.projects()) {
      const conversation = project.conversation as ConversationId
      const waiting = await store.harness.snapshot(WaitingDoc, conversation, context)
      if (waiting?.waiting?.kind !== 'login' || waiting.waiting.provider !== provider || waiting.tool) continue
      const turn = (await store.harness.snapshot(TurnDoc, conversation, context))?.turn
      if (turn !== null && turn !== undefined && turn.app !== version) {
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
    const { store, models, version } = this.#o
    const projects = await store.projects()
    const outdated: Conversation[] = []
    for (const project of projects) {
      const conversation = await this.#conversation(project.id)
      const { running, turn } = await this.#state(conversation)
      if (running && turn !== null && turn.app !== version) outdated.push(conversation)
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
      const recorded = (await store.harness.snapshot(WaitingDoc, conversation.id, context))?.failure ?? null
      if (state.failure !== undefined && state.failure.reason !== 'aborted' && state.failure.taskId !== recorded) {
        await this.#read(conversation, state.failure, state.turn)
      }
      const record = await store.harness.snapshot(WaitingDoc, conversation.id, context)
      const running = (await this.#state(conversation)).running
      if (record?.tool && !running) {
        // A tool held this wait, and its run is gone: nothing will let it go but this.
        await store.harness.commit(async (tx) => {
          const stale = await tx.doc(WaitingDoc, conversation.id)
          stale.waiting = null
          stale.tool = false
        }, context)
        continue
      }
      if (record === undefined || record.waiting?.kind !== 'login' || record.tool || running) continue
      const waiting = record.waiting
      if (state.turn !== null && state.turn.app !== version) await this.#outdated(conversation.id)
      else if (record.failure !== null && (await this.#savedSince(record, waiting.provider))) this.#resume(project.id, record.failure)
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
