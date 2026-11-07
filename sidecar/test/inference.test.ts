import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { inferenceModels, keyCredential } from '../src/inference'
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
