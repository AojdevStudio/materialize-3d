/**
 * The app's one store: Pi Durable over SQLite, in the app's Application Support folder. This is the only module that
 * opens it, and only one process may hold it, so every other module goes through what this one exports.
 *
 * App state lives as Pi documents on the root conversation. Each project is a conversation of its own.
 */
import { type Dirent, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import { type Conversation, defineDoc, type HarnessOptions, Harness, type Registry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { LoginIndex } from './inference'
import type { LegacyProject } from './legacy'
import { type Draft, type LoginKind, type ModelChoice, type Project, type SavedDraft, type Settings, type Setup, START, type StoredState, type Turn, type Waiting } from './protocol'
import { guideTemplate } from './templates/guide' with { type: 'macro' }

const context = BACKGROUND_CONTEXT

/** The app's guide template, made whole when the sidecar was built. */
const GUIDE_TEMPLATE = guideTemplate()

const always = () => true

const SetupDoc = defineDoc<Setup>({
  kind: 'm3d.setup',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ step: 'welcome', done: false }),
  checkpointWhen: always,
})

export const SettingsDoc = defineDoc<Settings>({
  kind: 'm3d.settings',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    model: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
    thinking: 'high',
    printer: {
      machine: 'Bambu Lab P2S 0.4 nozzle',
      process: '0.20mm Standard @BBL P2S',
      filament: 'Bambu PETG Basic @BBL P2S 0.4 nozzle',
    },
  }),
  checkpointWhen: always,
})

/**
 * The projects, and for each start screen draft revision that made one, that project and the draft it moved there, so
 * a send of that revision again makes no other project and still sends what went out, even after the project's draft
 * changed.
 */
export const ProjectsDoc = defineDoc<{ projects: Project[]; madeFor?: Record<string, { project: string; draft: SavedDraft }> }>({
  kind: 'm3d.projects',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ projects: [] }),
  checkpointWhen: always,
})

export const DraftsDoc = defineDoc<{ drafts: Record<string, SavedDraft>; seq?: number }>({
  kind: 'm3d.drafts',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ drafts: {} }),
  checkpointWhen: always,
})

/** What a project's current turn runs with, frozen in the commit that sent it. */
export const TurnDoc = defineDoc<{ turn: Turn | null }>({
  kind: 'm3d.turn',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ turn: null }),
  checkpointWhen: always,
})

/**
 * Why a project's turn waits, and the run failure that was read, so one failure is read once. `tool` marks a wait a
 * running tool holds, such as Astra's for a sign-in: the tool goes on by itself, so nothing continues the run. Cleared
 * in the commit that sends, retries, or resumes, or by the tool once its wait ends. `saves` is how many times the
 * turn's provider login was saved when the turn last went out, so a refusal can tell a login saved since then.
 */
export const WaitingDoc = defineDoc<{ waiting: Waiting | null; failure: number | null; tool: boolean; saves: number | null }>({
  kind: 'm3d.waiting',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ waiting: null, failure: null, tool: false, saves: null }),
  checkpointWhen: always,
})

/** How many times each provider's login was saved, so a wait can tell a new sign-in from the one a provider refused. */
export const LoginSavesDoc = defineDoc<{ saves: Record<string, number> }>({
  kind: 'm3d.login-saves',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ saves: {} }),
  checkpointWhen: always,
})

/** Which providers have a login in the Keychain. Never the secret itself. */
const LoginsDoc = defineDoc<{ logins: Record<string, LoginKind> }>({
  kind: 'm3d.logins',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ logins: {} }),
  checkpointWhen: always,
})

/** The store's SQLite storage, through Pi's own async adapter, which queues every operation and transaction. */
export const openStorage = (path: string) => openNodeSqliteStorage(path)

/** Why a send names a draft revision the store no longer holds: the person changed the draft since that save. */
export const DRAFT_CHANGED = 'The draft changed before it went out. Send it again.'

/** Another process owns the store. */
export class StoreInUse extends Error {}

/**
 * Takes the store for this process, or throws `StoreInUse`. SQLite's exclusive lock on a file of its own is a POSIX
 * lock, so the system drops it when this process ends, a crash included. The handle is kept for the process's life.
 */
function own(dir: string): DatabaseSync {
  const lock = new DatabaseSync(join(dir, 'owner.lock'), { timeout: 0 })
  try {
    lock.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE')
  } catch (error) {
    lock.close()
    if (error instanceof Error && /locked|busy/i.test(error.message)) {
      throw new StoreInUse('Another copy of Materialize 3D owns the store.')
    }
    throw error
  }
  return lock
}

function slug(title: string): string {
  const words = title.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const joined = words.join('-').slice(0, 40).replace(/-+$/, '')
  return joined === '' ? 'project' : joined
}

export interface StoreOptions {
  /** The folder for the store, in Application Support. */
  dataDir: string
  /** Where project folders go: the folder each project's agent works in. */
  projectsDir: string
  models: Models
  registry: Registry
  /** The files and processes a conversation's tools work in. */
  env: NonNullable<HarnessOptions['env']>
}

export class Store implements LoginIndex {
  readonly #lock: DatabaseSync
  readonly harness: Harness
  readonly root: Conversation
  readonly projectsDir: string

  private constructor(lock: DatabaseSync, harness: Harness, root: Conversation, projectsDir: string) {
    this.#lock = lock
    this.harness = harness
    this.root = root
    this.projectsDir = projectsDir
  }

  static async open(options: StoreOptions): Promise<Store> {
    mkdirSync(options.dataDir, { recursive: true })
    const lock = own(options.dataDir)
    const storage = await openStorage(join(options.dataDir, 'store.sqlite'))
    const harness = await Harness.open(storage, { models: options.models, registry: options.registry, env: options.env }, context)
    const root = await harness.root(context)
    return new Store(lock, harness, root, options.projectsDir)
  }

  /** The app's state at one point in the store's history: the four documents are read in one commit. */
  async state(): Promise<StoredState> {
    const id = this.root.id
    const state: StoredState = await this.harness.commit(
      async (tx) =>
        // A plain copy, since the documents a commit hands out are only valid inside it.
        JSON.parse(
          JSON.stringify({
            setup: await tx.doc(SetupDoc, id),
            settings: await tx.doc(SettingsDoc, id),
            projects: (await tx.doc(ProjectsDoc, id)).projects,
            drafts: (await tx.doc(DraftsDoc, id)).drafts,
          }),
        ),
      context,
    )
    state.projects.sort((a, b) => b.createdMs - a.createdMs)
    return state
  }

  async setSetup(setup: Setup): Promise<void> {
    await this.harness.commit(async (tx) => {
      Object.assign(await tx.doc(SetupDoc, this.root.id), setup)
    }, context)
  }

  async setSettings(change: Partial<Settings>): Promise<void> {
    await this.harness.commit(async (tx) => {
      Object.assign(await tx.doc(SettingsDoc, this.root.id), change)
    }, context)
  }

  /** Saves a draft, or removes an empty one, and answers its revision. A store from before revisions starts at 1. */
  async setDraft(key: string, draft: Draft): Promise<number> {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(DraftsDoc, this.root.id)
      const rev = (doc.seq ?? 0) + 1
      doc.seq = rev
      if (draft.text === '' && draft.attachments.length === 0) delete doc.drafts[key]
      else doc.drafts[key] = { ...draft, rev }
      return rev
    }, context)
  }

  /** Gives each draft saved before drafts had revisions one, so a send can take it away as it takes any other. */
  async reviseOldDrafts(): Promise<void> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(DraftsDoc, this.root.id)
      // A store from before revisions holds drafts without one, which this read is the only place to see.
      for (const draft of Object.values(doc.drafts) as (Draft & { rev?: number })[]) {
        if (draft.rev !== undefined) continue
        doc.seq = (doc.seq ?? 0) + 1
        draft.rev = doc.seq
      }
    }, context)
  }

  /**
   * The project the start screen's draft saved as `rev` goes to. The first time, it makes the project, titled by the
   * draft's first line, and moves that draft to it, in one commit. Only the draft saved as `rev` moves, so a newer
   * start screen draft is never sent in its place. The folder is made inside that commit, before anything is kept, so a
   * folder that cannot be made keeps nothing. A crash after the folder leaves an empty folder, which the next id skips.
   * Asked again for the same revision, as after a lost answer or a crash before the message, it answers the project
   * that revision made and the draft it moved, and changes nothing.
   */
  async startProject(rev: number): Promise<{ project: Project; draft: SavedDraft }> {
    const now = new Date()
    // The person's own date, as the folder name shows it.
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
    return this.harness.commit(async (tx) => {
      const index = await tx.doc(ProjectsDoc, this.root.id)
      const before = index.madeFor?.[rev]
      const made = index.projects.find((p) => p.id === before?.project)
      // A plain copy, since the documents a commit hands out are only valid inside it.
      if (before !== undefined && made !== undefined) return JSON.parse(JSON.stringify({ project: made, draft: before.draft }))
      const { drafts } = await tx.doc(DraftsDoc, this.root.id)
      const draft = drafts[START]
      if (draft?.rev !== rev) throw new Error(DRAFT_CHANGED)
      const title = (draft.text.split('\n')[0] ?? '').trim().slice(0, 80) || 'New part'
      const base = `${today}-${slug(title)}`
      const taken = new Set(index.projects.map((p) => p.id))
      let id = base
      // A folder already on disk, which the store may not list, is never taken over.
      for (let n = 2; taken.has(id) || existsSync(join(this.projectsDir, id)); n++) id = `${base}-${n}`
      this.projectFolder(id)
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      // The project keeps the model picked on the start screen, so a later pick there leaves it alone.
      const { model } = await tx.doc(SettingsDoc, this.root.id)
      const created: Project = { id, conversation: conversation.id, title, createdMs: now.getTime(), model: { provider: model.provider, modelId: model.modelId } }
      index.projects.push(created)
      const moved: SavedDraft = { text: draft.text, attachments: [...draft.attachments], rev }
      index.madeFor = { ...index.madeFor, [rev]: { project: id, draft: moved } }
      drafts[id] = draft
      delete drafts[START]
      return JSON.parse(JSON.stringify({ project: created, draft: moved }))
    }, context)
  }

  /** The drafts start screen sends moved to their projects, which a send of the same revision again still sends. */
  async startedDrafts(): Promise<SavedDraft[]> {
    const index = await this.harness.snapshot(ProjectsDoc, this.root.id, context)
    return Object.values(index?.madeFor ?? {}).map(({ draft }) => draft)
  }

  /** The draft saved under `key`, a project id or `START`. */
  async draft(key: string): Promise<SavedDraft | undefined> {
    return (await this.harness.snapshot(DraftsDoc, this.root.id, context))?.drafts[key]
  }

  async projects(): Promise<Project[]> {
    return (await this.harness.snapshot(ProjectsDoc, this.root.id, context))?.projects ?? []
  }

  async project(id: string): Promise<Project> {
    const project = (await this.projects()).find((p) => p.id === id)
    if (project === undefined) throw new Error(`no project ${id}`)
    return project
  }

  async projectOf(conversation: number): Promise<string> {
    const project = (await this.projects()).find((p) => p.conversation === conversation)
    if (project === undefined) throw new Error(`conversation ${conversation} is no project's`)
    return project.id
  }

  async logins(): Promise<Record<string, LoginKind>> {
    return (await this.harness.snapshot(LoginsDoc, this.root.id, context))?.logins ?? {}
  }

  async setLogin(provider: string, kind: LoginKind | undefined): Promise<void> {
    await this.harness.commit(async (tx) => {
      const { logins } = await tx.doc(LoginsDoc, this.root.id)
      if (kind === undefined) delete logins[provider]
      else {
        logins[provider] = kind
        const { saves } = await tx.doc(LoginSavesDoc, this.root.id)
        saves[provider] = (saves[provider] ?? 0) + 1
      }
    }, context)
  }

  /** How many times the provider's login was saved. */
  async loginSaves(provider: string): Promise<number> {
    return (await this.harness.snapshot(LoginSavesDoc, this.root.id, context))?.saves[provider] ?? 0
  }

  /**
   * Imports chats from before the store, each with its conversation and its place in the index in one commit. A
   * project already in the index was imported before, so each is imported once.
   */
  async importLegacy(legacy: LegacyProject[]): Promise<string[]> {
    const imported: string[] = []
    for (const old of legacy) {
      const done = await this.harness.commit(async (tx) => {
        const index = await tx.doc(ProjectsDoc, this.root.id)
        if (index.projects.some((p) => p.id === old.id)) return false
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        for (const data of old.entries) await tx.appendEntry(conversation.id, { kind: 'm3d.imported', data })
        index.projects.push({ id: old.id, conversation: conversation.id, title: old.title, createdMs: old.createdMs })
        return true
      }, context)
      if (done) imported.push(old.id)
    }
    return imported
  }

  /** Saves the model the project's next turn runs on. */
  async setModel(id: string, model: ModelChoice): Promise<void> {
    await this.harness.commit(async (tx) => {
      const project = (await tx.doc(ProjectsDoc, this.root.id)).projects.find((p) => p.id === id)
      if (project === undefined) throw new Error(`no project ${id}`)
      project.model = model
    }, context)
  }

  /** Marks a project printed. */
  async markPrinted(id: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const project = (await tx.doc(ProjectsDoc, this.root.id)).projects.find((p) => p.id === id)
      if (project === undefined) throw new Error(`no project ${id}`)
      project.printed = true
    }, context)
  }

  /**
   * What the project's folder holds for the sidebar: its `.3mf` files outside `refs/`, where the person's own files go,
   * and when a file in it last changed. Folders the file list skips are skipped here too. A folder not made yet is empty.
   */
  folderSummary(id: string): { printFiles: number; newestMs: number } {
    const root = join(this.projectsDir, id)
    const summary = { printFiles: 0, newestMs: 0 }
    if (!existsSync(root)) return summary
    const walk = (dir: string, refs: boolean) => {
      let entries: Dirent[]
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        // The agent may remove a folder while it is read. A folder that is gone holds nothing to count.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ['__pycache__', 'node_modules', 'venv'].includes(entry.name)) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path, refs || (dir === root && entry.name === 'refs'))
        else if (entry.isFile()) {
          // Likewise a file removed since the folder was read.
          const stat = statSync(path, { throwIfNoEntry: false })
          if (stat === undefined) continue
          summary.newestMs = Math.max(summary.newestMs, stat.mtimeMs)
          if (!refs && entry.name.toLowerCase().endsWith('.3mf')) summary.printFiles++
        }
      }
    }
    walk(root, false)
    return summary
  }

  /**
   * The project's folder, made if it is missing. It gets this app's guide template in its hidden folder each time, so
   * the agent's guide scripts read the template of the app that runs the turn, never one an older app left.
   */
  projectFolder(id: string): string {
    const dir = join(this.projectsDir, id)
    mkdirSync(join(dir, '.m3d'), { recursive: true })
    writeFileSync(join(dir, '.m3d', 'guide-template.html'), GUIDE_TEMPLATE)
    return dir
  }

  async close(): Promise<void> {
    await this.harness.close(context)
    this.#lock.close()
  }
}
