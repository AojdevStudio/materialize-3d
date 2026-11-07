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
import { type Conversation, defineDoc, Harness, type Registry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { LoginIndex } from './inference'
import type { AppState, Draft, LoginKind, Project, Settings, Setup } from './protocol'

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

const SettingsDoc = defineDoc<Settings>({
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
    const harness = await Harness.open(storage, { models: options.models, registry: options.registry }, context)
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
   * Makes a project: its conversation, its place in the index, and the start screen's draft moved to it, in one commit.
   * Its folder is made inside that commit, before anything is kept, so a folder that cannot be made keeps nothing and
   * the draft stays on the start screen. A crash after the folder leaves an empty folder, which the next id skips.
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
      if (draft !== undefined) {
        drafts[id] = draft
        delete drafts.new
      }
      return created
    }, context)
    return project
  }

  async logins(): Promise<Record<string, LoginKind>> {
    return (await this.harness.snapshot(LoginsDoc, this.root.id, context))?.logins ?? {}
  }

  async setLogin(provider: string, kind: LoginKind | undefined): Promise<void> {
    await this.harness.commit(async (tx) => {
      const { logins } = await tx.doc(LoginsDoc, this.root.id)
      if (kind === undefined) delete logins[provider]
      else logins[provider] = kind
    }, context)
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
