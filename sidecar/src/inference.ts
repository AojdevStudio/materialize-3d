/**
 * Inference only: the person's own logins to Anthropic, OpenAI Codex (the ChatGPT plan), and OpenCode Go, through
 * pi-ai. Logins live in the macOS Keychain, reached through Rust. The store keeps which providers have one, never
 * the secret. Nothing of the person's environment or files is read: no env var, no `auth.json`, no CLI config.
 */
import {
  type ApiKeyAuth,
  type AuthEvent,
  type AuthContext,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import { compile, lit, map, num, obj, opt, str, union } from '@earendil-works/pi-schema'
import type { Host } from './host'
import type { Login, LoginEvent, LoginKind, ProviderId } from './protocol'

/** The only providers the app offers. */
export const PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai-codex', 'opencode-go']

/** Auth sees an empty world: every env var is unset and no file exists. */
const noAmbient: AuthContext = { env: async () => undefined, fileExists: async () => false }

/** Where the proxy URL rides in an Anthropic credential. */
const BASE_URL = 'ANTHROPIC_BASE_URL'

/**
 * Anthropic by API key, or through a proxy: a base URL and a token sent as a bearer token, the way Ossie's Mac reaches
 * Anthropic. pi-ai's own key auth sends a key as `x-api-key` to api.anthropic.com only.
 */
const anthropicKeyOrProxy: ApiKeyAuth = {
  name: 'Anthropic API key or proxy',
  resolve: async ({ credential }) => {
    const key = credential?.key
    if (key === undefined) return undefined
    const baseUrl = credential?.env?.[BASE_URL]
    return baseUrl === undefined
      ? { auth: { apiKey: key }, source: 'API key' }
      : { auth: { headers: { Authorization: `Bearer ${key}` }, baseUrl }, source: 'proxy' }
  },
}

function anthropic(): Provider {
  const base = anthropicProvider()
  return { ...base, auth: { ...base.auth, apiKey: anthropicKeyOrProxy } }
}

const credential = compile(
  union([
    obj({ type: lit('api_key'), key: opt(str()), env: opt(map(str())) }),
    obj({ type: lit('oauth'), refresh: str(), access: str(), expires: num() }, { open: true }),
  ]),
)

/** Which providers have a login. Not secret: it lives in the store. */
export interface LoginIndex {
  logins(): Promise<Record<string, LoginKind>>
  setLogin(provider: string, kind: LoginKind | undefined): Promise<void>
}

/**
 * pi-ai's credential store, kept in the Keychain. Each provider's writes run one after another, as pi-ai requires,
 * because OAuth refresh happens inside `modify`. One process owns the store, so a lock in memory is enough.
 */
export class KeychainCredentials implements CredentialStore {
  readonly #host: Host
  readonly #index: LoginIndex
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(host: Host, index: LoginIndex) {
    this.#host = host
    this.#index = index
  }

  #serial<T>(provider: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#queues.get(provider) ?? Promise.resolve()).then(work, work)
    this.#queues.set(provider, run.catch(() => undefined))
    return run
  }

  async read(provider: string): Promise<Credential | undefined> {
    const { secret } = await this.#host.request('keychain.get', { account: provider })
    if (secret === null) return undefined
    const parsed: unknown = JSON.parse(secret)
    if (!credential.check(parsed)) throw new Error(`the Keychain login for ${provider} is not one this app wrote`)
    return parsed as Credential
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(await this.#index.logins()).map(([providerId, type]) => ({ providerId, type }))
  }

  modify(provider: string, change: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.#serial(provider, async () => {
      const current = await this.read(provider)
      const next = await change(current)
      if (next === undefined) return current
      await this.#host.request('keychain.set', { account: provider, secret: JSON.stringify(next) })
      await this.#index.setLogin(provider, next.type)
      return next
    })
  }

  delete(provider: string): Promise<void> {
    return this.#serial(provider, async () => {
      await this.#host.request('keychain.delete', { account: provider })
      await this.#index.setLogin(provider, undefined)
    })
  }
}

/** The models the agent can run on: the app's three providers, on the person's own logins. */
export function inferenceModels(credentials: CredentialStore): MutableModels {
  const models = createModels({ credentials, authContext: noAmbient, identity: { attribution: null } })
  models.setProvider(anthropic())
  models.setProvider(openaiCodexProvider())
  models.setProvider(opencodeGoProvider())
  return models
}

/** A key, or a base URL and token, saved as the provider's login. */
export function keyCredential(key: string, baseUrl: string | undefined): Credential {
  return baseUrl === undefined ? { type: 'api_key', key } : { type: 'api_key', key, env: { [BASE_URL]: baseUrl } }
}

/**
 * Sign-ins in progress. A provider's OAuth flow tells the window the page to open, and may ask for a code the person
 * pastes back, which `answer` hands over.
 */
export class Logins {
  readonly #models: MutableModels
  readonly #credentials: CredentialStore
  readonly #emit: (event: LoginEvent) => void
  readonly #asking = new Map<ProviderId, (text: string) => void>()

  constructor(models: MutableModels, credentials: CredentialStore, emit: (event: LoginEvent) => void) {
    this.#models = models
    this.#credentials = credentials
    this.#emit = emit
  }

  async status(): Promise<Login[]> {
    const stored = new Map((await this.#credentials.list()).map((info) => [info.providerId, info.type]))
    return PROVIDERS.map((id) => {
      const provider = this.#models.getProvider(id)
      if (provider === undefined) throw new Error(`provider ${id} is not registered`)
      const kinds: LoginKind[] = []
      if (provider.auth.apiKey !== undefined && id !== 'openai-codex') kinds.push('api_key')
      if (provider.auth.oauth !== undefined) kinds.push('oauth')
      return { provider: id, name: provider.name, login: stored.get(id) ?? null, kinds }
    })
  }

  async setKey(provider: ProviderId, key: string, baseUrl: string | undefined): Promise<void> {
    await this.#credentials.modify(provider, async () => keyCredential(key, baseUrl))
    this.#emit({ type: 'login', provider, step: 'done' })
  }

  /** Starts a subscription sign-in. Its progress arrives as events; it ends with `done` or `failed`. */
  login(provider: ProviderId): void {
    const interaction = {
      prompt: (prompt: { message: string }) =>
        new Promise<string>((resolve) => {
          this.#asking.set(provider, resolve)
          this.#emit({ type: 'login', provider, step: 'ask', message: prompt.message })
        }),
      notify: (event: AuthEvent) => {
        if (event.type === 'auth_url') this.#emit({ type: 'login', provider, step: 'open', url: event.url })
        if (event.type === 'device_code') {
          this.#emit({ type: 'login', provider, step: 'open', url: event.verificationUri, code: event.userCode })
        }
      },
    }
    this.#models.login(provider, 'oauth', interaction).then(
      () => this.#emit({ type: 'login', provider, step: 'done' }),
      (error: unknown) => this.#emit({ type: 'login', provider, step: 'failed', detail: error instanceof Error ? error.message : String(error) }),
    ).finally(() => this.#asking.delete(provider))
  }

  answer(provider: ProviderId, text: string): void {
    const waiting = this.#asking.get(provider)
    if (waiting === undefined) throw new Error(`${provider} is not asking for anything`)
    this.#asking.delete(provider)
    waiting(text)
  }

  async logout(provider: ProviderId): Promise<void> {
    await this.#models.logout(provider)
  }
}
