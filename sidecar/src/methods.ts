import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { arr, bool, compile, int, lit, obj, opt, str, union } from '@earendil-works/pi-schema'
import { toolchainNeeds } from './agent'
import type { Chats } from './chat'
import type { Handlers } from './host'
import type { Logins } from './inference'
import type { AppState, Need } from './protocol'
import type { Store } from './store'

export interface Services {
  store: Store
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
const printer = obj({ machine: str(), process: str(), filament: str() })
const provider = union([lit('anthropic'), lit('openai-codex'), lit('opencode-go')])

/** Every method the window can call, each parsed at the pipe before it runs. */
export function handlers({ store, logins, chats, version, legacy, pictures }: Services): Handlers {
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
      params: compile(obj({ model: opt(model), thinking: opt(thinking), printer: opt(printer) })),
      run: async (change) => {
        await store.setSettings(change)
        return state()
      },
    },
    'setup.check': {
      params: compile(obj({})),
      run: async () => {
        // The chosen model must be one the app offers, and its provider must have a login. A refused or expired login
        // still waits in the turn, with its fix.
        const { settings } = await store.state()
        const offered = await logins.status()
        const login = offered.find((l) => l.provider === settings.model.provider)
        const needs: Need[] =
          login === undefined
            ? [{ kind: 'model', fix: `Choose a model from ${offered.map((l) => l.name).join(', ')}. The app does not offer ${settings.model.provider}.` }]
            : login.login === null
              ? [{ kind: 'login', provider: login.provider, name: login.name, fix: `Sign in to ${login.name} before you send.` }]
              : []
        return [...needs, ...(await toolchainNeeds())]
      },
    },
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
    'agent.tools': { params: compile(obj({ project: str() })), run: ({ project }) => chats.tools(project) },
  }
}
