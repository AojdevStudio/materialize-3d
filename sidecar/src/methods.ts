import type { Models } from '@earendil-works/pi-ai'
import { arr, bool, compile, int, lit, nullable, obj, opt, str, union } from '@earendil-works/pi-schema'
import { toolchain, toolchainNeeds } from './agent'
import type { Chats } from './chat'
import type { Handlers, Host } from './host'
import type { Logins } from './inference'
import { offered } from './offered'
import { savePicture } from './pictures'
import { type AppState, type ModelChoice, type Need, PLATES, PROVIDERS, SETUP_STEPS, THINKING } from './protocol'
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
}

const step = union(SETUP_STEPS.map((value) => lit(value)))
const thinking = union(THINKING.map((value) => lit(value)))
const model = obj({ provider: str(), modelId: str() })
const plate = union(PLATES.map((value) => lit(value)))
const printer = obj({ machine: str({ minLength: 1 }), process: str({ minLength: 1 }), filament: str({ minLength: 1 }), plate: opt(plate) })
const provider = union(PROVIDERS.map((value) => lit(value)))

/**
 * Every method the window can call, each parsed at the pipe before it runs. `sidecar/test/protocol.test.ts` checks that
 * each params schema takes exactly what `Methods` names.
 */
export function handlers({ host, store, models, logins, chats, version, legacy, pictures }: Services) {
  const state = async (): Promise<AppState> => ({ ...(await store.state()), importBlocked: legacy.blocked() })
  const runnable = (model: ModelChoice) => {
    if (models.getModel(model.provider, model.modelId) === undefined) throw new Error(`${model.provider} has no model ${model.modelId}`)
  }
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
        const pair = await store.pairFor(project)
        const replace = store.retiredRoles(pair, await store.retired()).map((retired): Need => ({ kind: 'model', fix: store.retiredFix(retired), retired }))
        return [...replace, ...(await logins.needsFor(pair.lead)), ...(await toolchainNeeds())]
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
      params: compile(obj({ key: str({ minLength: 1 }), rev: int() })),
      run: async ({ key, rev }) => ({ project: await chats.send(key, rev) }),
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
    'models.list': { params: compile(obj({})), run: async () => logins.runnable(offered(store.catalog, await store.retired())) },
    'projects.setLead': {
      params: compile(obj({ project: str(), model })),
      run: async ({ project, model }) => {
        runnable(model)
        await store.setLead(project, model)
        return null
      },
    },
    'projects.setHelper': {
      params: compile(obj({ project: str(), model: nullable(model) })),
      run: async ({ project, model }) => {
        if (model !== null) runnable(model)
        await store.setHelper(project, model)
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
  } satisfies Handlers
}
