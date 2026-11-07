import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore, type OAuthAuth } from '@earendil-works/pi-ai'
import { inferenceModels, KeychainCredentials, keyCredential, Logins } from '../src/inference'
import type { LoginEvent, LoginKind } from '../src/protocol'
import { spawnSidecar } from './sidecar'

const TOKEN = 'sk-proxy-SENTINEL-7f3a9c'

describe('logins', () => {
  test('a proxy token goes to the Keychain only, never to the store or the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-login-'))
    const keychain = new Map<string, string>()
    const app = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), keychain)
    await app.next()
    const status = await app.call('auth.setKey', { provider: 'anthropic', key: TOKEN, baseUrl: 'http://127.0.0.1:8317' })
    expect(status).toContainEqual({ provider: 'anthropic', name: 'Anthropic', login: 'api_key', kinds: ['api_key', 'oauth'] })
    expect(await app.next()).toEqual({ kind: 'event', event: { type: 'login', provider: 'anthropic', step: 'done' } })
    expect(JSON.parse(keychain.get('anthropic') ?? '{}')).toEqual({ type: 'api_key', key: TOKEN, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317' } })
    await app.quit()

    const stderr = await app.stderr()
    expect(stderr).not.toContain(TOKEN)
    const files = readdirSync(join(dir, 'state'))
    expect(files).toContain('store.sqlite')
    for (const file of files) expect(readFileSync(join(dir, 'state', file)).includes(TOKEN)).toBe(false)

    const reopened = spawnSidecar(join(dir, 'state'), join(dir, 'projects'), keychain)
    await reopened.next()
    expect(await reopened.call('auth.status')).toContainEqual({ provider: 'anthropic', name: 'Anthropic', login: 'api_key', kinds: ['api_key', 'oauth'] })
    await reopened.call('auth.logout', { provider: 'anthropic' })
    expect(keychain.has('anthropic')).toBe(false)
    await reopened.quit()
  })

  test('a proxy login sends the token as a bearer token to the proxy', async () => {
    const credentials = new InMemoryCredentialStore()
    await credentials.modify('anthropic', async () => keyCredential(TOKEN, 'http://127.0.0.1:8317'))
    const auth = await inferenceModels(credentials).getAuth('anthropic')
    expect(auth?.auth).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` }, baseUrl: 'http://127.0.0.1:8317' })
  })

  test("the person's own keys and logins are never read", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-the-persons-shell'
    process.env.ANTHROPIC_AUTH_TOKEN = 'token-from-the-persons-shell'
    process.env.OPENCODE_API_KEY = 'oc-from-the-persons-shell'
    const models = inferenceModels(new InMemoryCredentialStore())
    for (const provider of ['anthropic', 'openai-codex', 'opencode-go']) expect(await models.getAuth(provider)).toBeUndefined()
  })
})

describe('subscription sign-ins', () => {
  /** The app's models with Anthropic's sign-in replaced by `login`, and every login event the window would get. */
  function withSignIn(login: OAuthAuth['login']) {
    const credentials = new InMemoryCredentialStore()
    const models = inferenceModels(credentials)
    const anthropic = models.getProvider('anthropic')
    if (anthropic === undefined) throw new Error('no anthropic provider')
    const oauth: OAuthAuth = { name: 'Anthropic (scripted)', login, refresh: async (c) => c, toAuth: async (c) => ({ apiKey: c.access }) }
    models.setProvider({ ...anthropic, auth: { ...anthropic.auth, oauth } })
    const events: LoginEvent[] = []
    return { logins: new Logins(models, credentials, (event) => events.push(event)), credentials, events }
  }
  const settle = () => Bun.sleep(20)

  test('a key for a provider that has no key sign-in is refused, and its login stays as it was', async () => {
    const credentials = new InMemoryCredentialStore()
    const oauth = { type: 'oauth' as const, refresh: 'r', access: 'a', expires: Date.now() + 60_000 }
    await credentials.modify('openai-codex', async () => oauth)
    const events: LoginEvent[] = []
    const logins = new Logins(inferenceModels(credentials), credentials, (event) => events.push(event))
    await expect(logins.setKey('openai-codex', 'sk-not-for-codex', undefined)).rejects.toThrow('takes its own sign-in, not a key')
    expect(await credentials.read('openai-codex')).toEqual(oauth)
    expect(events).toEqual([])
  })

  test('a choice the provider asks for reaches the window with its options, and the answer goes back', async () => {
    const { logins, events, credentials } = withSignIn(async (interaction) => {
      const method = await interaction.prompt({ type: 'select', message: 'Choose a login method', options: [{ id: 'console', label: 'Console' }, { id: 'claude', label: 'Claude.ai' }] })
      return { type: 'oauth', refresh: 'r', access: `token-for-${method}`, expires: Date.now() + 60_000 }
    })
    logins.login('anthropic')
    await settle()
    expect(events).toEqual([
      { type: 'login', provider: 'anthropic', step: 'ask', kind: 'select', message: 'Choose a login method', options: [{ id: 'console', label: 'Console' }, { id: 'claude', label: 'Claude.ai' }] },
    ])
    logins.answer('anthropic', 'claude')
    await settle()
    expect(events.at(-1)).toEqual({ type: 'login', provider: 'anthropic', step: 'done' })
    expect(await credentials.read('anthropic')).toMatchObject({ type: 'oauth', access: 'token-for-claude' })
  })

  test("a failed sign-in never sends the provider's error text, which can hold a token", async () => {
    const { logins, events } = withSignIn(async () => {
      throw new Error('bad response: {"access_token":"sk-ant-oat-SENTINEL"}')
    })
    logins.login('anthropic')
    await settle()
    expect(events).toEqual([{ type: 'login', provider: 'anthropic', step: 'failed', detail: 'Signing in to Anthropic did not finish. Try again.' }])
    expect(JSON.stringify(events)).not.toContain('SENTINEL')
  })

  test('a newer sign-in or a sign-out cancels an unfinished one, which then saves nothing', async () => {
    let started = 0
    const { logins, events, credentials } = withSignIn(async (interaction) => {
      started += 1
      const code = await interaction.prompt({ type: 'manual_code', message: `Paste code ${started}` })
      return { type: 'oauth', refresh: 'r', access: code, expires: Date.now() + 60_000 }
    })
    logins.login('anthropic')
    await settle()
    logins.login('anthropic')
    await settle()
    logins.answer('anthropic', 'second')
    await settle()
    expect(events.filter((e) => e.step !== 'ask')).toEqual([{ type: 'login', provider: 'anthropic', step: 'done' }])
    expect(await credentials.read('anthropic')).toMatchObject({ access: 'second' })

    logins.login('anthropic')
    await settle()
    await logins.logout('anthropic')
    expect(() => logins.answer('anthropic', 'late')).toThrow('not asking')
    await settle()
    expect(await credentials.read('anthropic')).toBeUndefined()
    expect(events.filter((e) => e.step === 'done')).toHaveLength(1)
  })

  test('a sign-in cancelled after the provider answered saves nothing and shows nothing more', async () => {
    let finish: () => void = () => {}
    const { logins, events, credentials } = withSignIn(async (interaction) => {
      await new Promise<void>((resolve) => (finish = resolve))
      interaction.notify({ type: 'auth_url', url: 'https://example.com/old' })
      return { type: 'oauth', refresh: 'r', access: 'late', expires: Date.now() + 60_000 }
    })
    logins.login('anthropic')
    await settle()
    await logins.logout('anthropic')
    finish()
    await settle()
    expect(await credentials.read('anthropic')).toBeUndefined()
    expect(events).toEqual([])
  })
})

describe('the compiled sidecar', () => {
  test('reaches the first step of both subscription sign-ins, with no source files or node_modules beside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm3d-compiled-'))
    try {
      const bin = join(dir, 'materialize-sidecar')
      const built = Bun.spawnSync(['bun', 'build', '--compile', join(import.meta.dir, '..', 'src', 'main.ts'), '--outfile', bin])
      expect(built.exitCode).toBe(0)
      const app = Bun.spawn([bin, '--app-version', '0.0.0', '--data', join(dir, 'state'), '--projects', join(dir, 'projects')], {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin', HOME: dir },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      })
      app.stdin.write('{"kind":"call","id":1,"method":"auth.login","params":{"provider":"anthropic"}}\n')
      app.stdin.write('{"kind":"call","id":2,"method":"auth.login","params":{"provider":"openai-codex"}}\n')
      app.stdin.flush()
      const steps = new Map<string, string>()
      const decoder = new TextDecoder()
      let buffered = ''
      for await (const chunk of app.stdout) {
        buffered += decoder.decode(chunk)
        for (const line of buffered.split('\n').slice(0, -1)) {
          const message = JSON.parse(line) as { kind: string; event?: { type: string; provider: string; step: string } }
          if (message.event?.type === 'login' && !steps.has(message.event.provider)) steps.set(message.event.provider, message.event.step)
        }
        buffered = buffered.slice(buffered.lastIndexOf('\n') + 1)
        if (steps.size === 2) break
      }
      app.kill()
      expect(Object.fromEntries(steps)).toEqual({ anthropic: 'ask', 'openai-codex': 'ask' })
    } finally {
      // The binary is over 100 MB.
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('the Keychain credential store', () => {
  test('a cancelled save writes nothing, whether it was cancelled before its turn or while it ran', async () => {
    const keychain = new Map<string, string>()
    const request = async (method: string, params: { account: string; secret?: string }) => {
      if (method === 'keychain.get') return { secret: keychain.get(params.account) ?? null }
      if (method === 'keychain.set') keychain.set(params.account, params.secret ?? '')
      if (method === 'keychain.delete') keychain.delete(params.account)
      return null
    }
    const logins: Record<string, LoginKind> = {}
    const store = new KeychainCredentials({ request } as never, {
      logins: async () => logins,
      setLogin: async (provider, kind) => {
        if (kind === undefined) delete logins[provider]
        else logins[provider] = kind
      },
    })
    const credential = { type: 'oauth' as const, refresh: 'r', access: 'a', expires: 1 }

    const before = new AbortController()
    before.abort()
    await expect(store.modify('anthropic', async () => credential, { signal: before.signal })).rejects.toThrow()

    const during = new AbortController()
    await expect(
      store.modify('anthropic', async () => {
        during.abort()
        return credential
      }, { signal: during.signal }),
    ).rejects.toThrow()
    expect(keychain.size).toBe(0)
    expect(logins).toEqual({})

    await store.modify('anthropic', async () => credential)
    expect(JSON.parse(keychain.get('anthropic') ?? '{}')).toEqual(credential)
  })

  test('a save cancelled while its login was being listed puts the earlier login back in both places', async () => {
    const keychain = new Map<string, string>()
    const request = async (method: string, params: { account: string; secret?: string }) => {
      if (method === 'keychain.get') return { secret: keychain.get(params.account) ?? null }
      if (method === 'keychain.set') keychain.set(params.account, params.secret ?? '')
      if (method === 'keychain.delete') keychain.delete(params.account)
      return null
    }
    const logins: Record<string, LoginKind> = {}
    const listing = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let gate = false
    const store = new KeychainCredentials({ request } as never, {
      logins: async () => logins,
      setLogin: async (provider, kind) => {
        if (gate) {
          gate = false
          listing.resolve()
          await finish.promise
        }
        if (kind === undefined) delete logins[provider]
        else logins[provider] = kind
      },
    })
    const earlier = { type: 'api_key' as const, key: 'earlier' }
    await store.modify('anthropic', async () => earlier)

    const cancel = new AbortController()
    gate = true
    const save = store.modify('anthropic', async () => ({ type: 'oauth' as const, refresh: 'r', access: 'a', expires: 1 }), { signal: cancel.signal })
    await listing.promise
    cancel.abort()
    finish.resolve()
    await expect(save).rejects.toThrow()
    expect(JSON.parse(keychain.get('anthropic') ?? '{}')).toEqual(earlier)
    expect(logins).toEqual({ anthropic: 'api_key' })
  })

  test('a save cancelled while the Keychain wrote it puts the earlier login back', async () => {
    const keychain = new Map<string, string>()
    const written = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let gate = false
    const request = async (method: string, params: { account: string; secret?: string }) => {
      if (method === 'keychain.get') return { secret: keychain.get(params.account) ?? null }
      if (method === 'keychain.set') {
        keychain.set(params.account, params.secret ?? '')
        if (gate) {
          gate = false
          written.resolve()
          await finish.promise
        }
      }
      if (method === 'keychain.delete') keychain.delete(params.account)
      return null
    }
    const logins: Record<string, LoginKind> = {}
    const store = new KeychainCredentials({ request } as never, {
      logins: async () => logins,
      setLogin: async (provider, kind) => {
        if (kind === undefined) delete logins[provider]
        else logins[provider] = kind
      },
    })
    const earlier = { type: 'api_key' as const, key: 'earlier' }
    await store.modify('openai-codex', async () => earlier)

    const cancel = new AbortController()
    gate = true
    const save = store.modify('openai-codex', async () => ({ type: 'oauth' as const, refresh: 'r', access: 'a', expires: 1 }), { signal: cancel.signal })
    await written.promise
    cancel.abort()
    finish.resolve()
    await expect(save).rejects.toThrow()
    expect(JSON.parse(keychain.get('openai-codex') ?? '{}')).toEqual(earlier)
    expect(logins).toEqual({ 'openai-codex': 'api_key' })
  })
})
