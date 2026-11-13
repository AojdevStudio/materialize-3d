import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Models } from '@earendil-works/pi-ai'
import { arr, bool, compile, int, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import { toolchain, toolchainNeeds } from './agent'
import type { Chats } from './chat'
import type { Handlers, Host } from './host'
import type { Logins } from './inference'
import { OFFERED } from './offered'
import type { AppState, Need } from './protocol'
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

const step = union([lit('welcome'), lit('check'), lit('model'), lit('printer'), lit('ready')])
const thinking = union([lit('off'), lit('minimal'), lit('low'), lit('medium'), lit('high'), lit('xhigh'), lit('max')])
const model = obj({ provider: str(), modelId: str() })
const plate = union([lit('Cool Plate'), lit('Engineering Plate'), lit('High Temp Plate'), lit('Textured PEI Plate'), lit('Supertack Plate')])
const printer = obj({ machine: str({ minLength: 1 }), process: str({ minLength: 1 }), filament: str({ minLength: 1 }), plate: opt(plate) })
const provider = union([lit('anthropic'), lit('openai-codex'), lit('opencode-go')])

/** Every method the window can call, each parsed at the pipe before it runs. */
export function handlers({ host, store, models, logins, chats, version, legacy, pictures }: Services): Handlers {
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
        // The model the next turn runs on must be one the app offers, and its provider must have a login: the project's
        // own model, or the default on the start screen. A refused or expired login still waits in the turn, with its fix.
        const { settings } = await store.state()
        const model = (project === undefined ? undefined : (await store.project(project)).model) ?? settings.model
        const offered = await logins.status()
        const login = offered.find((l) => l.provider === model.provider)
        const needs: Need[] =
          login === undefined
            ? [{ kind: 'model', fix: `Choose a model from ${offered.map((l) => l.name).join(', ')}. The app does not offer ${model.provider}.` }]
            : login.login === null
              ? [{ kind: 'login', provider: login.provider, name: login.name, fix: `Sign in to ${login.name} before you send.` }]
              : []
        return [...needs, ...(await toolchainNeeds())]
      },
    },
    'setup.tools': { params: compile(obj({})), run: () => toolchain() },
    'legacy.import': { params: compile(obj({})), run: () => legacy.retry() },
    'drafts.picture': {
      params: compile(obj({ name: str({ minLength: 1 }), data: str() })),
      run: async ({ name, data }) => {
        // Only a plain file name: the picture's folder is the sidecar's, not one the window names.
        if (basename(name) !== name || name.startsWith('.')) throw new Error(`${name} is not a picture's file name`)
        const folder = join(pictures, crypto.randomUUID())
        mkdirSync(folder, { recursive: true })
        const path = join(folder, name)
        writeFileSync(path, Buffer.from(data, 'base64'))
        return path
      },
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
    'models.list': {
      params: compile(obj({})),
      run: async () => {
        const signedIn = new Set((await logins.status()).flatMap((login) => (login.login === null ? [] : [login.provider])))
        // The pi-ai catalog can lack a model on the short list. That model cannot run, so its row stays out.
        return OFFERED.filter((m) => signedIn.has(m.provider) && models.getModel(m.provider, m.modelId) !== undefined)
      },
    },
    'projects.setModel': {
      params: compile(obj({ project: str(), model })),
      run: async ({ project, model }) => {
        if (models.getModel(model.provider, model.modelId) === undefined) throw new Error(`${model.provider} has no model ${model.modelId}`)
        await store.setModel(project, model)
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
  }
}
