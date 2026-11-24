/**
 * The app's one store: Pi Durable over SQLite, in the app's Application Support folder. This is the only module that
 * opens it, and only one process may hold it, so every other module goes through what this one exports.
 *
 * App state lives as Pi documents on the root conversation, and only this module reads or writes them. Each project is
 * a conversation of its own, whose chat keeps its own documents there (`chat.ts`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import { type Conversation, defineDoc, type HarnessOptions, Harness, type Registry, type Tx } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Imported } from './entries'
import type { LegacyProject } from './legacy'
import { CATALOG, type Catalog, DEFAULT_MODEL, modelName, replacementFor } from './offered'
import {
  ASTRA_MODEL,
  type Draft,
  META_DIR,
  type ModelChoice,
  type PairedDevice,
  type Printer,
  type Project,
  type Retired,
  type Role,
  type SavedDraft,
  type Settings,
  type Setup,
  START,
  type StoredState,
  type Thinking,
} from './protocol'
import { guideTemplate } from './templates/guide' with { type: 'macro' }

const context = BACKGROUND_CONTEXT

/** The app's guide template, made whole when the sidecar was built. */
const GUIDE_TEMPLATE = guideTemplate()

const always = () => true

const SetupDoc = defineDoc<Setup>({
  kind: 'm3d.setup-steps',
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
    model: { ...DEFAULT_MODEL },
    thinking: 'high',
    printer: {
      machine: 'Bambu Lab P2S 0.4 nozzle',
      process: '0.20mm Standard @BBL P2S',
      filament: 'Bambu PETG Basic @BBL P2S 0.4 nozzle',
    },
    astra: true,
  }),
  checkpointWhen: always,
})

/**
 * The projects, and for each start screen draft revision that made one, that project and the draft it moved there, so
 * a send of that revision again makes no other project and still sends what went out, even after the project's draft
 * changed.
 */
const ProjectsDoc = defineDoc<{ projects: Project[]; madeFor: Record<string, { project: string; draft: SavedDraft }> }>({
  kind: 'm3d.projects',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ projects: [], madeFor: {} }),
  checkpointWhen: always,
})

/** The drafts, and `seq`, the revision the last save of any draft took. */
const DraftsDoc = defineDoc<{ drafts: Record<string, SavedDraft>; seq: number }>({
  kind: 'm3d.drafts',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ drafts: {}, seq: 0 }),
  checkpointWhen: always,
})

/**
 * The phone service's own record: `computer`, the id a paired device knows this computer by, made on first need, and
 * each paired device with the SHA-256 hex of its token. A token itself is never kept.
 */
const MobileDoc = defineDoc<{ computer: string; devices: (PairedDevice & { tokenHash: string })[] }>({
  kind: 'm3d.mobile',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ computer: '', devices: [] }),
  checkpointWhen: always,
})

/** How many times each provider's login was saved, so a wait can tell a new sign-in from the one a provider refused. */
const LoginSavesDoc = defineDoc<{ saves: Record<string, number> }>({
  kind: 'm3d.login-saves',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ saves: {} }),
  checkpointWhen: always,
})

/** The pair a chat from before pairs carries on with: the lead it ran on, and Astra while the Astra setting was on. */
const carried = (settings: Settings, model: ModelChoice | undefined) => ({
  model: { ...(model ?? settings.model) },
  helper: settings.astra ? { ...ASTRA_MODEL } : null,
})

/** A plain copy of a model, since the documents a commit hands out are only valid inside it. */
const copy = ({ provider, modelId }: ModelChoice): ModelChoice => ({ provider, modelId })

/** Why a send names a draft revision the store no longer holds: the person changed the draft since that save. */
const DRAFT_CHANGED = 'The draft changed before it went out. Send it again.'

/** Whether `draft` is still the save `rev`. A draft saved after it is the next message, even one that reads the same. */
const holds = (draft: SavedDraft | undefined, rev: number): draft is SavedDraft => draft?.rev === rev

/**
 * What a send of the draft saved as `rev` is known by: its request id in the chat, and its folder in `refs/`, which its
 * files are copied to. A start screen send also keeps its project in `madeFor` under `rev`.
 */
export const sendName = (rev: number) => `draft-${rev}`

/**
 * The draft key of a paired device's draft for a project, apart from the computer's own draft for it. No project id
 * holds a `/`, so no device key is a project's.
 */
export const deviceDraft = (device: string, project: string) => `device/${device}/${project}`
const isDeviceDraft = (key: string) => key.startsWith('device/')

/** A device as the window and the phone see it, without its token's hash. */
const shown = ({ id, name, pairedMs }: PairedDevice): PairedDevice => ({ id, name, pairedMs })

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
  /** Tests only: a catalog in place of the app's. */
  catalog?: Catalog
}

export class Store {
  readonly #lock: DatabaseSync
  readonly harness: Harness
  readonly root: Conversation
  readonly projectsDir: string
  /** The model families the app offers, and every version of each it knows. */
  readonly catalog: Catalog

  private constructor(lock: DatabaseSync, harness: Harness, root: Conversation, projectsDir: string, catalog: Catalog) {
    this.#lock = lock
    this.harness = harness
    this.root = root
    this.projectsDir = projectsDir
    this.catalog = catalog
  }

  static async open(options: StoreOptions): Promise<Store> {
    mkdirSync(options.dataDir, { recursive: true })
    const lock = own(options.dataDir)
    // SQLite through Pi's own async adapter, which queues every operation and transaction.
    const storage = await openNodeSqliteStorage(join(options.dataDir, 'store.sqlite'))
    const harness = await Harness.open(storage, { models: options.models, registry: options.registry, env: options.env }, context)
    const root = await harness.root(context)
    const store = new Store(lock, harness, root, options.projectsDir, options.catalog ?? CATALOG)
    await store.#migrate()
    return store
  }

  /** Brings what earlier versions of the app kept up to this one, before anything else reads the store. */
  async #migrate(): Promise<void> {
    const id = this.root.id
    // Read before the commit, which hands out a missing document as its initial value and so hides that it is missing.
    const [setup, setupBefore, settings] = await Promise.all([
      this.harness.snapshot(SetupDoc, id, context),
      this.harness.snapshot(SetupBeforeSetupScreens, id, context),
      this.harness.snapshot(SettingsDoc, id, context),
    ])
    await this.harness.commit(async (tx) => {
      // A store an app before setup used opens with setup done. The first open by an app with setup decides it once.
      if (setup === undefined && setupBefore !== undefined) (await tx.doc(SetupDoc, id)).done = true
      // Settings saved before the Astra setting have none. Astra was always offered then, so it stays on.
      if (settings !== undefined && !('astra' in settings)) (await tx.doc(SettingsDoc, id)).astra = true
      // Each draft saved before drafts had revisions gets one, so a send takes it away as it takes any other.
      const drafts: DraftsBefore = await tx.doc(DraftsDoc, id)
      drafts.seq ??= 0
      for (const draft of Object.values(drafts.drafts)) {
        if (draft.rev !== undefined) continue
        drafts.seq++
        draft.rev = drafts.seq
      }
      const projects: ProjectsBefore = await tx.doc(ProjectsDoc, id)
      projects.madeFor ??= {}
      // Each project from before pairs carries on with the lead it ran on and the helper the Astra setting gave it.
      const now = await tx.doc(SettingsDoc, id)
      for (const project of projects.projects) {
        if (project.helper === undefined) Object.assign(project, carried(now, project.model))
      }
    }, context)
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
    // A paired device's drafts are its own, and the window never shows them.
    for (const key of Object.keys(state.drafts)) if (isDeviceDraft(key)) delete state.drafts[key]
    return state
  }

  /**
   * Every draft the store holds, the paired devices' too, and the drafts start screen sends moved to their projects,
   * which a send of the same revision again still sends.
   */
  async keptDrafts(): Promise<SavedDraft[]> {
    const [drafts, index] = await Promise.all([this.harness.snapshot(DraftsDoc, this.root.id, context), this.harness.snapshot(ProjectsDoc, this.root.id, context)])
    return [...Object.values(drafts?.drafts ?? {}), ...Object.values(index?.madeFor ?? {}).map(({ draft }) => draft)]
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

  /** Whether the Settings Astra switch is on. */
  async astra(): Promise<boolean> {
    return this.harness.commit(async (tx) => (await tx.doc(SettingsDoc, this.root.id)).astra, context)
  }

  async printer(): Promise<Printer> {
    return this.harness.commit(async (tx) => ({ ...(await tx.doc(SettingsDoc, this.root.id)).printer }), context)
  }

  /** Saves a draft, or removes an empty one, and answers its revision. */
  async setDraft(key: string, draft: Draft): Promise<number> {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(DraftsDoc, this.root.id)
      const rev = doc.seq + 1
      doc.seq = rev
      if (draft.text === '' && draft.attachments.length === 0) delete doc.drafts[key]
      else doc.drafts[key] = { ...draft, rev }
      return rev
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
  async startProject(rev: number, helper: ModelChoice | null): Promise<{ project: Project; draft: SavedDraft }> {
    const now = new Date()
    // The person's own date, as the folder name shows it.
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
    return this.harness.commit(async (tx) => {
      const index = await tx.doc(ProjectsDoc, this.root.id)
      const before = index.madeFor[rev]
      const made = index.projects.find((p) => p.id === before?.project)
      // A plain copy, since the documents a commit hands out are only valid inside it.
      if (before !== undefined && made !== undefined) return JSON.parse(JSON.stringify({ project: made, draft: before.draft }))
      const { drafts } = await tx.doc(DraftsDoc, this.root.id)
      const draft = drafts[START]
      if (!holds(draft, rev)) throw new Error(DRAFT_CHANGED)
      const title = (draft.text.split('\n')[0] ?? '').trim().slice(0, 80) || 'New part'
      const base = `${today}-${slug(title)}`
      const taken = new Set(index.projects.map((p) => p.id))
      let id = base
      // A folder already on disk, which the store may not list, is never taken over.
      for (let n = 2; taken.has(id) || existsSync(join(this.projectsDir, id)); n++) id = `${base}-${n}`
      this.projectFolder(id)
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } })
      // The project keeps the lead picked on the start screen, so a later pick there leaves it alone. It gets `helper`
      // while the Astra setting is on.
      const { model, astra } = await tx.doc(SettingsDoc, this.root.id)
      const created: Project = { id, conversation: conversation.id, title, createdMs: now.getTime(), model: copy(model), helper: astra && helper !== null ? copy(helper) : null }
      index.projects.push(created)
      const moved: SavedDraft = { text: draft.text, attachments: [...draft.attachments], rev }
      index.madeFor[rev] = { project: id, draft: moved }
      drafts[id] = draft
      delete drafts[START]
      return JSON.parse(JSON.stringify({ project: created, draft: moved }))
    }, context)
  }

  /** The draft saved as `rev` under `key`, a project id or `START`, while no newer save took its place. */
  async draft(key: string, rev: number): Promise<SavedDraft> {
    const draft = (await this.harness.snapshot(DraftsDoc, this.root.id, context))?.drafts[key]
    if (!holds(draft, rev)) throw new Error(DRAFT_CHANGED)
    return draft
  }

  /**
   * The store's part of a send's commit, for the draft saved as `rev` under `key`, the project's id or a device's key
   * for it: the pair the turn runs with, and that draft taken away. A newer save stays, and so does every other key's.
   * `saves` counts the saves of the login of the lead's provider. A role the chat found retired is refused, with the
   * fix, and nothing changes.
   */
  async send(tx: Tx, project: string, key: string, rev: number): Promise<{ lead: ModelChoice; helper: ModelChoice | null; thinking: Thinking; saves: number }> {
    const { thinking, astra } = await tx.doc(SettingsDoc, this.root.id)
    const saved = await this.#projectIn(tx, project)
    const { model, helper } = this.#gated(saved, astra)
    const [gone] = this.#retiredRoles(saved, astra)
    if (gone !== undefined) throw new Error(this.retiredFix(gone))
    const { drafts } = await tx.doc(DraftsDoc, this.root.id)
    if (holds(drafts[key], rev)) delete drafts[key]
    return { lead: copy(model), helper: helper === null ? null : copy(helper), thinking, saves: await this.loginSavesIn(tx, model.provider) }
  }

  /**
   * The roles of `project` its provider reported removed, lead first, while the person has not chosen again. A helper
   * the Astra switch keeps off is not one, since the next turn does not run it.
   */
  #retiredRoles(project: Project, astra: boolean): Retired[] {
    const retired = project.retired ?? []
    return [...retired.filter((r) => r.role === 'lead'), ...(astra ? retired.filter((r) => r.role === 'helper') : [])].map(({ role, model }) => ({
      role,
      model: copy(model),
      replacement: replacementFor(this.catalog, model),
    }))
  }

  /**
   * What the person does about a retired role: choose the newest version of its family, or another model when the
   * family has none left. A helper can also be turned off.
   */
  retiredFix({ role, model, replacement }: Retired): string {
    const choose = replacement === null ? `Choose another ${role} model` : `Choose ${modelName(replacement, this.catalog)}`
    const other = role === 'lead' ? (replacement === null ? '' : ' or another lead model') : ' or turn the helper off'
    return `${modelName(model, this.catalog)}, the ${role} model, was retired. ${choose}${other}.`
  }

  /**
   * A project's pair as its next turn runs it: lead-alone while the Settings Astra switch is off. Until each chat gets
   * its own helper control (#350), that switch is the window's only way to stop handoffs.
   */
  #gated(project: Project, astra: boolean): Pick<Project, 'model' | 'helper'> {
    return { model: project.model, helper: astra ? project.helper : null }
  }

  async #projectIn(tx: Tx, id: string): Promise<Project> {
    const project = (await tx.doc(ProjectsDoc, this.root.id)).projects.find((p) => p.id === id)
    if (project === undefined) throw new Error(`no project ${id}`)
    return project
  }

  /**
   * The pair the next turn of `project` runs with. With no project, as on the start screen, the start screen's lead,
   * alone.
   */
  async pairFor(project?: string): Promise<{ lead: ModelChoice; helper: ModelChoice | null }> {
    return this.harness.commit(async (tx) => {
      if (project === undefined) return { lead: copy((await tx.doc(SettingsDoc, this.root.id)).model), helper: null }
      const { model, helper } = this.#gated(await this.#projectIn(tx, project), (await tx.doc(SettingsDoc, this.root.id)).astra)
      return { lead: copy(model), helper: helper === null ? null : copy(helper) }
    }, context)
  }

  /** The lead of `project`, read in the commit `tx`. */
  async leadIn(tx: Tx, project: string): Promise<ModelChoice> {
    return copy((await this.#projectIn(tx, project)).model)
  }

  /** The roles of `project` its provider reported removed and the person has not chosen again, lead first. */
  async retiredFor(project: string): Promise<Retired[]> {
    return this.harness.commit(async (tx) => this.#retiredRoles(await this.#projectIn(tx, project), (await tx.doc(SettingsDoc, this.root.id)).astra), context)
  }

  /** `retiredFor`, read in the commit `tx`. */
  async retiredIn(tx: Tx, project: string): Promise<Retired[]> {
    return this.#retiredRoles(await this.#projectIn(tx, project), (await tx.doc(SettingsDoc, this.root.id)).astra)
  }

  /**
   * Records, in the commit `tx`, that a provider reported `model` removed while `project` ran it as `role`. It holds
   * that role of that chat only, until the person chooses again, so an answer misread as a removal costs one choice and
   * hides nothing anywhere else. A role the person already changed records nothing.
   */
  async retire(tx: Tx, project: string, role: Role, model: ModelChoice): Promise<Retired> {
    const retired: Retired = { role, model: copy(model), replacement: replacementFor(this.catalog, model) }
    const saved = await this.#projectIn(tx, project)
    const current = role === 'lead' ? saved.model : saved.helper
    if (current?.provider === model.provider && current.modelId === model.modelId) {
      saved.retired = [...(saved.retired ?? []).filter((r) => r.role !== role), { role, model: copy(model) }]
    }
    return retired
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

  async loginSaved(provider: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const { saves } = await tx.doc(LoginSavesDoc, this.root.id)
      saves[provider] = (saves[provider] ?? 0) + 1
    }, context)
  }

  async loginSaves(provider: string): Promise<number> {
    return (await this.harness.snapshot(LoginSavesDoc, this.root.id, context))?.saves[provider] ?? 0
  }

  /** `loginSaves`, read in the commit `tx`. */
  async loginSavesIn(tx: Tx, provider: string): Promise<number> {
    return (await tx.doc(LoginSavesDoc, this.root.id)).saves[provider] ?? 0
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
        for (const data of old.entries) await tx.appendEntry(Imported, conversation.id, { data })
        const pair = carried(await tx.doc(SettingsDoc, this.root.id), undefined)
        index.projects.push({ id: old.id, conversation: conversation.id, title: old.title, createdMs: old.createdMs, ...pair })
        return true
      }, context)
      if (done) imported.push(old.id)
    }
    return imported
  }

  /** Saves the lead the next turn of project `id` runs on. The choice lets go a lead the chat found retired. */
  async setLead(id: string, model: ModelChoice): Promise<void> {
    await this.harness.commit(async (tx) => {
      const project = await this.#projectIn(tx, id)
      project.model = copy(model)
      project.retired = (project.retired ?? []).filter((r) => r.role !== 'lead')
    }, context)
  }

  /**
   * Saves the helper the next turn of project `id` can hand tasks to, or null for none. The choice lets go a helper the
   * chat found retired.
   */
  async setHelper(id: string, model: ModelChoice | null): Promise<void> {
    await this.harness.commit(async (tx) => {
      const project = await this.#projectIn(tx, id)
      project.helper = model === null ? null : copy(model)
      project.retired = (project.retired ?? []).filter((r) => r.role !== 'helper')
    }, context)
  }

  async markPrinted(id: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const project = (await tx.doc(ProjectsDoc, this.root.id)).projects.find((p) => p.id === id)
      if (project === undefined) throw new Error(`no project ${id}`)
      project.printed = true
    }, context)
  }

  /**
   * The project's folder, made if it is missing. A send calls this before it gives a turn this app's instructions, so
   * the folder then holds this app's guide template in its hidden folder, which those instructions describe.
   */
  projectFolder(id: string): string {
    const dir = join(this.projectsDir, id)
    mkdirSync(join(dir, META_DIR), { recursive: true })
    writeFileSync(join(dir, META_DIR, 'guide-template.html'), GUIDE_TEMPLATE)
    return dir
  }

  /** The id paired devices know this computer by, made the first time it is asked for. */
  async computer(): Promise<string> {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(MobileDoc, this.root.id)
      if (doc.computer === '') doc.computer = crypto.randomUUID()
      return doc.computer
    }, context)
  }

  /** Pairs a device by the hash of its new token, and answers it. */
  async addDevice(name: string, tokenHash: string): Promise<PairedDevice> {
    const device: PairedDevice = { id: crypto.randomUUID(), name, pairedMs: Date.now() }
    await this.harness.commit(async (tx) => {
      ;(await tx.doc(MobileDoc, this.root.id)).devices.push({ ...device, tokenHash })
    }, context)
    return device
  }

  /** The paired devices, first paired first. */
  async devices(): Promise<PairedDevice[]> {
    return ((await this.harness.snapshot(MobileDoc, this.root.id, context))?.devices ?? []).map(shown)
  }

  /** The paired device whose token has this hash, or undefined when none has. */
  async deviceFor(tokenHash: string): Promise<PairedDevice | undefined> {
    const device = (await this.harness.snapshot(MobileDoc, this.root.id, context))?.devices.find((d) => d.tokenHash === tokenHash)
    return device === undefined ? undefined : shown(device)
  }

  /** Forgets a paired device and its drafts, in one commit, and answers the devices left. */
  async forgetDevice(id: string): Promise<PairedDevice[]> {
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(MobileDoc, this.root.id)
      doc.devices = doc.devices.filter((device) => device.id !== id)
      const { drafts } = await tx.doc(DraftsDoc, this.root.id)
      for (const key of Object.keys(drafts)) if (key.startsWith(deviceDraft(id, ''))) delete drafts[key]
    }, context)
    return this.devices()
  }

  async close(): Promise<void> {
    await this.harness.close(context)
    this.#lock.close()
  }
}

/*
 * What earlier versions of the app kept, which `Store.#migrate` brings up to this one.
 */

/**
 * v0.3.0 and earlier wrote this document on every state read and never changed it, so it says only that one of them
 * ran here. This app reads it and never writes it, so those versions still open the store.
 */
const SetupBeforeSetupScreens = defineDoc<Setup>({
  kind: 'm3d.setup',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ step: 'welcome', done: false }),
  checkpointWhen: always,
})

/**
 * The drafts as an earlier version may have left them: no `seq` before the first save, and from a store before drafts
 * had revisions, drafts without `rev`.
 */
type DraftsBefore = { drafts: Record<string, Draft & { rev?: number }>; seq?: number }

/**
 * The projects as an earlier version left them: no `madeFor` before the first start screen send, and from before
 * pairs, projects with no helper and maybe no lead.
 */
type ProjectsBefore = {
  projects: (Omit<Project, 'model' | 'helper'> & { model?: ModelChoice; helper?: ModelChoice | null })[]
  madeFor?: Record<string, { project: string; draft: SavedDraft }>
}
