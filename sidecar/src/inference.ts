/**
 * Inference only: the person's own logins to Anthropic, OpenAI Codex (the ChatGPT plan), and OpenCode Go, through
 * pi-ai. Logins live in the macOS Keychain, reached through Rust. The store keeps which providers have one, never
 * the secret. Nothing of the person's environment or files is read: no env var, no `auth.json`, no CLI config.
 */
import {
  type ApiKeyAuth,
  type AuthInteraction,
  type AuthOperationOptions,
  type AuthContext,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  createModels,
  type MutableModels,
  type Provider,
} from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
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

/**
 * A provider's answer that means the login itself is missing or refused, not that the request failed. A 403 alone is
 * not one: it says the login works but lacks access, which a new sign-in to the same account does not change.
 */
const LOGIN_FAILURE = /not configured|\b401\b|unauthori[sz]ed|authentication|invalid (api )?(key|token)|expired/i

export const isLoginFailure = (detail: string) => LOGIN_FAILURE.test(detail)

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
  readonly #host: Pick<Host, 'request'>
  readonly #index: LoginIndex
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(host: Pick<Host, 'request'>, index: LoginIndex) {
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

  /**
   * A sign-in that was cancelled, by a newer one or a sign-out, writes nothing, even once its turn in line comes, and
   * one cancelled while it was saved leaves the earlier login in place, in the Keychain and in the index.
   */
  modify(provider: string, change: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.#serial(provider, async () => {
      options?.signal?.throwIfAborted()
      const current = await this.read(provider)
      const next = await change(current)
      options?.signal?.throwIfAborted()
      if (next === undefined) return current
      await this.#host.request('keychain.set', { account: provider, secret: JSON.stringify(next) })
      await this.#index.setLogin(provider, next.type)
      if (options?.signal?.aborted) {
        // Cancelled while it was saved: the earlier login goes back, in the Keychain and in the index, before anything
        // else reads this one.
        if (current === undefined) await this.#host.request('keychain.delete', { account: provider })
        else await this.#host.request('keychain.set', { account: provider, secret: JSON.stringify(current) })
        await this.#index.setLogin(provider, current?.type)
        options.signal.throwIfAborted()
      }
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
  // pi-ai loads a provider's sign-in with an import a bundler cannot follow, so the compiled sidecar would have none.
  // Registering them statically puts both subscription sign-ins in the binary.
  registerBunOAuthFlows()
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

/** One subscription sign-in in progress: it can be cancelled, and it may be waiting for the person's answer. */
type Attempt = { abort: AbortController; answer: ((text: string) => void) | undefined }

/**
 * Sign-ins in progress, at most one per provider. A provider's OAuth flow tells the window the page to open, and may
 * ask for a choice or a code, which `answer` hands over. A newer sign-in, a key, or a sign-out cancels an older one, so
 * a sign-in left unfinished can never bring a login back.
 */
export class Logins {
  readonly #models: MutableModels
  readonly #credentials: CredentialStore
  readonly #emit: (event: LoginEvent) => void
  readonly #attempts = new Map<ProviderId, Attempt>()

  constructor(models: MutableModels, credentials: CredentialStore, emit: (event: LoginEvent) => void) {
    this.#models = models
    this.#credentials = credentials
    this.#emit = emit
  }

  #cancel(provider: ProviderId): void {
    this.#attempts.get(provider)?.abort.abort()
    this.#attempts.delete(provider)
  }

  async status(): Promise<Login[]> {
    const stored = new Map((await this.#credentials.list()).map((info) => [info.providerId, info.type]))
    return PROVIDERS.map((id) => {
      const provider = this.#models.getProvider(id)
      if (provider === undefined) throw new Error(`provider ${id} is not registered`)
      const kinds: LoginKind[] = []
      if (provider.auth.apiKey !== undefined) kinds.push('api_key')
      if (provider.auth.oauth !== undefined) kinds.push('oauth')
      return { provider: id, name: provider.name, login: stored.get(id) ?? null, kinds }
    })
  }

  /** Saves a key as the provider's login. A provider that has no key sign-in refuses it before its login changes. */
  async setKey(provider: ProviderId, key: string, baseUrl: string | undefined): Promise<void> {
    const known = this.#models.getProvider(provider)
    if (known?.auth.apiKey === undefined) throw new Error(`${known?.name ?? provider} takes its own sign-in, not a key.`)
    this.#cancel(provider)
    await this.#credentials.modify(provider, async () => keyCredential(key, baseUrl))
    this.#emit({ type: 'login', provider, step: 'done' })
  }

  /** Starts a subscription sign-in. Its progress arrives as events; it ends with `done` or `failed`. */
  login(provider: ProviderId): void {
    this.#cancel(provider)
    const attempt: Attempt = { abort: new AbortController(), answer: undefined }
    this.#attempts.set(provider, attempt)
    const { signal } = attempt.abort
    const interaction: AuthInteraction = {
      signal,
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          // A cancelled sign-in asks nothing more: its question would land over the newer one's.
          if (signal.aborted) return reject(new Error('the sign-in was cancelled'))
          signal.addEventListener('abort', () => reject(new Error('the sign-in was cancelled')), { once: true })
          attempt.answer = resolve
          const options = prompt.type === 'select' ? { options: prompt.options.map(({ id, label }) => ({ id, label })) } : {}
          this.#emit({ type: 'login', provider, step: 'ask', kind: prompt.type, message: prompt.message, ...options })
        }),
      notify: (event) => {
        if (signal.aborted) return
        if (event.type === 'auth_url') this.#emit({ type: 'login', provider, step: 'open', url: event.url })
        if (event.type === 'device_code') {
          this.#emit({ type: 'login', provider, step: 'open', url: event.verificationUri, code: event.userCode })
        }
      },
    }
    const name = this.#models.getProvider(provider)?.name ?? provider
    this.#models
      .login(provider, 'oauth', interaction)
      .then(
        () => {
          if (!signal.aborted) this.#emit({ type: 'login', provider, step: 'done' })
        },
        () => {
          // A provider's error can carry what its server sent back, tokens included, so its text never leaves here.
          if (!signal.aborted) this.#emit({ type: 'login', provider, step: 'failed', detail: `Signing in to ${name} did not finish. Try again.` })
        },
      )
      .finally(() => {
        if (this.#attempts.get(provider) === attempt) this.#attempts.delete(provider)
      })
  }

  answer(provider: ProviderId, text: string): void {
    const attempt = this.#attempts.get(provider)
    const answer = attempt?.answer
    if (attempt === undefined || answer === undefined) throw new Error(`${provider} is not asking for anything`)
    attempt.answer = undefined
    answer(text)
  }

  async logout(provider: ProviderId): Promise<void> {
    this.#cancel(provider)
    await this.#models.logout(provider)
  }
}
