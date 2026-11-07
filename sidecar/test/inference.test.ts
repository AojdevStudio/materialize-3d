import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore, type OAuthAuth } from '@earendil-works/pi-ai'
import { inferenceModels, keyCredential, Logins } from '../src/inference'
import type { LoginEvent } from '../src/protocol'
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

    const stderr = await new Response(app.child.stderr).text()
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
})
