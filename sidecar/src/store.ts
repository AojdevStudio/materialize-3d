/**
 * The app's one store: Pi Durable over SQLite, in the app's Application Support folder. This is the only module that
 * opens it, and only one process may hold it, so every other module goes through what this one exports.
 *
 * App state lives as Pi documents on the root conversation. Each project is a conversation of its own.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import { type Conversation, defineDoc, type HarnessOptions, Harness, type Registry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { LoginIndex } from './inference'
import type { LegacyProject } from './legacy'
import type { AppState, Draft, LoginKind, Project, Settings, Setup, Turn, Waiting } from './protocol'

const context = BACKGROUND_CONTEXT

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

const ProjectsDoc = defineDoc<{ projects: Project[] }>({
  kind: 'm3d.projects',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ projects: [] }),
  checkpointWhen: always,
})

export const DraftsDoc = defineDoc<{ drafts: Record<string, Draft> }>({
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
  async state(): Promise<AppState> {
    const id = this.root.id
    const state: AppState = await this.harness.commit(
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

  async setDraft(key: string, draft: Draft): Promise<void> {
    await this.harness.commit(async (tx) => {
      const { drafts } = await tx.doc(DraftsDoc, this.root.id)
      if (draft.text === '' && draft.attachments.length === 0) delete drafts[key]
      else drafts[key] = draft
    }, context)
  }

  /**
   * Makes a project: its conversation, its place in the index, and the start screen's draft moved to it when that
   * draft holds the project's first message, in one commit. A start screen draft with other text is the person's next
   * idea, so it stays. The folder is made inside that commit, before anything is kept, so a folder that cannot be made
   * keeps nothing. A crash after the folder leaves an empty folder, which the next id skips.
   */
  async createProject(title: string): Promise<Project> {
    const firstLine = (title.split('\n')[0] ?? '').trim().slice(0, 80) || 'New part'
    const now = new Date()
    // The person's own date, as the folder name shows it.
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
    const base = `${today}-${slug(firstLine)}`
    const project = await this.harness.commit(async (tx) => {
      const index = await tx.doc(ProjectsDoc, this.root.id)
      const taken = new Set(index.projects.map((p) => p.id))
      let id = base
      // A folder already on disk, which the store may not list, is never taken over.
      for (let n = 2; taken.has(id) || existsSync(join(this.projectsDir, id)); n++) id = `${base}-${n}`
      this.projectFolder(id)
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      const created: Project = { id, conversation: conversation.id, title: firstLine, createdMs: now.getTime() }
      index.projects.push(created)
      const { drafts } = await tx.doc(DraftsDoc, this.root.id)
      const draft = drafts.new
      if (draft !== undefined && draft.text.trim() === title.trim()) {
        drafts[id] = draft
        delete drafts.new
      }
      return created
    }, context)
    return project
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

  /** The project's folder, made if it is missing. */
  projectFolder(id: string): string {
    const dir = join(this.projectsDir, id)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  async close(): Promise<void> {
    await this.harness.close(context)
    this.#lock.close()
  }
}
