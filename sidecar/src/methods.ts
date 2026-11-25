import type { Models } from '@earendil-works/pi-ai'
import { arr, bool, compile, int, lit, nullable, obj, opt, str, union } from '@earendil-works/pi-schema'
import { toolchain, toolchainNeeds } from './agent'
import type { Chats } from './chat'
import type { Handlers, Host } from './host'
import type { Logins } from './inference'
import type { Mobile } from './mobile'
import { offered } from './offered'
import { savePicture } from './pictures'
import { type AppState, type ModelChoice, type Need, PLATES, type Project, PROVIDERS, SETUP_STEPS, type SidecarEvent, THINKING } from './protocol'
import type { Store } from './store'

export interface Services {
  host: Host
  store: Store
  models: Models
  logins: Logins
  chats: Chats
  version: string
  /** The import of the chats from before the store: the folder it could not read, and a way to run it again. */
  legacy: { blocked(): string | null; retry(): Promise<{ imported: number; blocked: string | null }> }
  /** The folder pasted pictures are kept in until they are sent, outside every project. */
  pictures: string
  mobile: Mobile
  /** Tells the window and every paired device's open stream. */
  emit(event: SidecarEvent): void
}

const step = union(SETUP_STEPS.map((value) => lit(value)))
const thinking = union(THINKING.map((value) => lit(value)))
export const model = obj({ provider: str(), modelId: str() })
const plate = union(PLATES.map((value) => lit(value)))
const printer = obj({ machine: str({ minLength: 1 }), process: str({ minLength: 1 }), filament: str({ minLength: 1 }), plate: opt(plate) })
const provider = union(PROVIDERS.map((value) => lit(value)))

/**
 * Saves a project's roles, from the window or a paired device, and tells both. A model pi-ai cannot run is refused here,
 * and a retired one by the store. Either refusal saves neither role.
 */
export async function saveRoles(
  { store, models, emit }: Pick<Services, 'store' | 'models' | 'emit'>,
  id: string,
  change: { lead?: ModelChoice; helper?: ModelChoice | null },
): Promise<Project> {
  for (const model of [change.lead, change.helper]) {
    if (model !== undefined && model !== null && models.getModel(model.provider, model.modelId) === undefined) throw new Error(`${model.provider} has no model ${model.modelId}`)
  }
  const project = await store.setRoles(id, change)
  emit({ type: 'project', project })
  return project
}

/** The models both roles offer: the newest version of each family, for the providers the person signed in to. */
export const offeredModels = async (store: Store, logins: Logins) => logins.runnable(offered(store.catalog))

/**
 * Every method the window can call, each parsed at the pipe before it runs. `sidecar/test/protocol.test.ts` checks that
 * each params schema takes exactly what `Methods` names.
 */
export function handlers(services: Services) {
  const { host, store, logins, chats, version, legacy, pictures, mobile } = services
  const state = async (): Promise<AppState> => ({ ...(await store.state()), importBlocked: legacy.blocked() })
  return {
    'app.ping': { params: compile(obj({})), run: async () => ({ version }) },
    'state.get': { params: compile(obj({})), run: state },
    'setup.set': {
      params: compile(obj({ step, done: bool() })),
      run: async (setup) => {
        await store.setSetup(setup)
        return state()
      },
    },
    'settings.set': {
      params: compile(obj({ model: opt(model), thinking: opt(thinking), astra: opt(bool()) })),
      run: async (change) => {
        await store.setSettings(change)
        return state()
      },
    },
    'printer.set': {
      params: compile(printer),
      run: async (chosen) => {
        await host.request('printer.check', chosen)
        await store.setSettings({ printer: chosen })
        return state()
      },
    },
    'setup.check': {
      params: compile(obj({ project: opt(str()) })),
      run: async ({ project }) => {
        const retired = project === undefined ? [] : await store.retiredFor(project)
        const replace = retired.map((r): Need => ({ kind: 'model', fix: store.retiredFix(r), retired: r }))
        return [...replace, ...(await logins.needsFor((await store.pairFor(project)).lead)), ...(await toolchainNeeds())]
      },
    },
    'setup.tools': { params: compile(obj({})), run: () => toolchain() },
    'legacy.import': { params: compile(obj({})), run: () => legacy.retry() },
    'drafts.picture': {
      params: compile(obj({ name: str({ minLength: 1 }), data: str() })),
      run: async ({ name, data }) => savePicture(pictures, name, data),
    },
    'drafts.set': {
      params: compile(obj({ key: str(), text: str(), attachments: arr(str()) })),
      run: async ({ key, text, attachments }) => ({ rev: await store.setDraft(key, { text, attachments }) }),
    },
    'auth.status': { params: compile(obj({})), run: () => logins.status() },
    'auth.setKey': {
      params: compile(obj({ provider, key: str({ minLength: 1 }), baseUrl: opt(str({ minLength: 1 })) })),
      run: async ({ provider, key, baseUrl }) => {
        await logins.setKey(provider, key, baseUrl)
        return logins.status()
      },
    },
    'auth.login': {
      params: compile(obj({ provider })),
      run: async ({ provider }) => {
        logins.login(provider)
        return null
      },
    },
    'auth.answer': {
      params: compile(obj({ provider, text: str() })),
      run: async ({ provider, text }) => {
        logins.answer(provider, text)
        return null
      },
    },
    'auth.logout': {
      params: compile(obj({ provider })),
      run: async ({ provider }) => {
        await logins.logout(provider)
        return logins.status()
      },
    },
    'chat.open': { params: compile(obj({ project: str() })), run: ({ project }) => chats.open(project) },
    'chat.send': {
      params: compile(obj({ key: str({ minLength: 1 }), rev: int(), pair: opt(obj({ lead: model, helper: opt(nullable(model)) })) })),
      run: async ({ key, rev, pair }) => {
        for (const role of pair === undefined ? [] : [pair.lead, pair.helper]) {
          if (role !== undefined && role !== null && services.models.getModel(role.provider, role.modelId) === undefined) throw new Error(`${role.provider} has no model ${role.modelId}`)
        }
        return { project: await chats.send(key, rev, key, pair) }
      },
    },
    'chat.stop': {
      params: compile(obj({ project: str() })),
      run: async ({ project }) => {
        await chats.stop(project)
        return null
      },
    },
    'chat.retry': {
      params: compile(obj({ project: str() })),
      run: async ({ project }) => {
        await chats.retry(project)
        return null
      },
    },
    'models.list': { params: compile(obj({})), run: () => offeredModels(store, logins) },
    'projects.setLead': {
      params: compile(obj({ project: str(), model })),
      run: async ({ project, model }) => {
        await saveRoles(services, project, { lead: model })
        return null
      },
    },
    'projects.setHelper': {
      params: compile(obj({ project: str(), model: nullable(model) })),
      run: async ({ project, model }) => {
        await saveRoles(services, project, { helper: model })
        return null
      },
    },
    'projects.status': { params: compile(obj({})), run: () => chats.status() },
    'projects.markPrinted': {
      params: compile(obj({ project: str() })),
      run: async ({ project }) => {
        await store.markPrinted(project)
        return null
      },
    },
    'agent.tools': { params: compile(obj({ project: str() })), run: ({ project }) => chats.tools(project) },
    'mobile.pair': { params: compile(obj({})), run: () => mobile.pair() },
    'mobile.devices': { params: compile(obj({})), run: () => store.devices() },
    'mobile.forget': { params: compile(obj({ device: str() })), run: ({ device }) => mobile.forget(device) },
  } satisfies Handlers
}
