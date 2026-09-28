// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Tauri mocks ──
const invokeMock = vi.fn()
const listenMock = vi.fn()
const openUrlMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: openUrlMock,
}))

// ── Pi SDK mocks (subset needed for agent.ts) ──
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn((_provider: string, _modelId: string) => ({
    id: _modelId,
    provider: _provider,
    api: 'messages',
  })),
  getProviders: vi.fn(() => ['anthropic', 'openai']),
  getModels: vi.fn((_provider: string) => [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4', provider: _provider, api: 'messages' },
  ]),
}))

vi.mock('@mariozechner/pi-web-ui', () => ({
  defaultConvertToLlm: vi.fn((messages: unknown[]) => messages),
  AppStorage: vi.fn(),
  IndexedDBStorageBackend: vi.fn(),
  SettingsStore: vi.fn(() => ({ getConfig: vi.fn(), setBackend: vi.fn() })),
  ProviderKeysStore: vi.fn(() => ({
    getConfig: vi.fn(),
    setBackend: vi.fn(),
    get: vi.fn(),
  })),
  SessionsStore: Object.assign(vi.fn(() => ({ getConfig: vi.fn(), setBackend: vi.fn() })), {
    getMetadataConfig: vi.fn(),
  }),
  CustomProvidersStore: vi.fn(() => ({ getConfig: vi.fn(), setBackend: vi.fn() })),
  setAppStorage: vi.fn(),
}))

// We import the real oauth index module for registry checks, but mock out
// the parts that use Node.js APIs (the built-in providers' login functions).
// refreshAnthropicToken and refreshOpenAICodexToken use fetch, which jsdom provides.

describe('oauth-providers: registration', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    openUrlMock.mockReset()
  })

  afterEach(async () => {
    // Reset provider registry to defaults
    const { resetOAuthProviders } = await import(
      '@mariozechner/pi-ai/oauth'
    )
    resetOAuthProviders()
  })

  it('registers custom providers and they are retrievable via getOAuthProvider', async () => {
    const { registerTauriOAuthProviders } = await import('../agent/oauth-providers')
    const { getOAuthProvider } = await import(
      '@mariozechner/pi-ai/oauth'
    )

    registerTauriOAuthProviders()

    const anthropic = getOAuthProvider('anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic!.name).toBe('Anthropic (Claude Pro/Max)')
    expect(anthropic!.usesCallbackServer).toBe(true)

    const openai = getOAuthProvider('openai-codex')
    expect(openai).toBeDefined()
    expect(openai!.name).toBe('ChatGPT Plus/Pro (Codex Subscription)')
    expect(openai!.usesCallbackServer).toBe(true)
  })

  it('custom providers have correct IDs matching built-in providers', async () => {
    const { anthropicTauriProvider, openaiTauriProvider } = await import(
      '../agent/oauth-providers'
    )

    expect(anthropicTauriProvider.id).toBe('anthropic')
    expect(openaiTauriProvider.id).toBe('openai-codex')
  })
})

describe('oauth-providers: getApiKey with Keychain', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    listenMock.mockReset()
    openUrlMock.mockReset()
  })

  afterEach(async () => {
    const { resetOAuthProviders } = await import(
      '@mariozechner/pi-ai/oauth'
    )
    resetOAuthProviders()
  })

  it('getApiKey resolves from mocked Keychain when credentials exist', async () => {
    const { registerTauriOAuthProviders } = await import('../agent/oauth-providers')
    registerTauriOAuthProviders()

    const storedCreds = {
      refresh: 'mock-refresh-token',
      access: 'mock-access-token-abc123',
      expires: Date.now() + 3600 * 1000, // 1 hour from now (not expired)
    }

    // Mock invoke to return stored credential JSON for get_credential
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_credential' && args?.key === 'oauth:anthropic') {
        return JSON.stringify(storedCreds)
      }
      return null
    })

    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    // Access the getApiKey from agent config — it's passed to Agent constructor
    // We test it indirectly through the agent's getApiKey callback
    const apiKey = await (agent as any).getApiKey('anthropic')

    expect(apiKey).toBe('mock-access-token-abc123')
    expect(invokeMock).toHaveBeenCalledWith('get_credential', { key: 'oauth:anthropic' })
  })

  it('expired credential triggers refresh and Keychain writeback', async () => {
    const { registerTauriOAuthProviders } = await import('../agent/oauth-providers')
    registerTauriOAuthProviders()

    const expiredCreds = {
      refresh: 'mock-refresh-token',
      access: 'old-expired-access-token',
      expires: Date.now() - 1000, // expired 1 second ago
    }

    const refreshedCreds = {
      refresh_token: 'new-refresh-token',
      access_token: 'new-access-token-xyz789',
      expires_in: 3600,
    }

    // Mock invoke for get_credential and store_credential
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_credential' && args?.key === 'oauth:anthropic') {
        return JSON.stringify(expiredCreds)
      }
      if (cmd === 'store_credential') {
        return undefined
      }
      return null
    })

    // Mock the fetch call for token refresh
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(refreshedCreds), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    const apiKey = await (agent as any).getApiKey('anthropic')

    expect(apiKey).toBe('new-access-token-xyz789')

    // Verify store_credential was called with the refreshed creds
    const storeCalls = invokeMock.mock.calls.filter(
      (call: unknown[]) => call[0] === 'store_credential'
    )
    expect(storeCalls.length).toBeGreaterThan(0)
    const storedValue = JSON.parse(
      (storeCalls[0][1] as { value: string }).value
    )
    expect(storedValue.access).toBe('new-access-token-xyz789')
    expect(storedValue.refresh).toBe('new-refresh-token')

    fetchSpy.mockRestore()
  })

  it('missing Keychain credential falls through to IndexedDB fallback', async () => {
    const { registerTauriOAuthProviders } = await import('../agent/oauth-providers')
    registerTauriOAuthProviders()

    // Mock invoke: no credential in Keychain
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_credential') {
        return null
      }
      return null
    })

    // Since we can't easily mock IndexedDB storage in this test,
    // we verify that the function doesn't throw and returns undefined
    // when both Keychain and IndexedDB have nothing
    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    const apiKey = await (agent as any).getApiKey('anthropic')

    // Should be undefined since no Keychain data and storage isn't initialized
    expect(apiKey).toBeUndefined()
  })

  it('getApiKey returns the access token string, not the full credential object', async () => {
    const { registerTauriOAuthProviders } = await import('../agent/oauth-providers')
    registerTauriOAuthProviders()

    const storedCreds = {
      refresh: 'ref-token',
      access: 'acc-token-string-only',
      expires: Date.now() + 3600 * 1000,
      accountId: 'acct-123', // extra field (OpenAI style)
    }

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'get_credential' && args?.key === 'oauth:openai-codex') {
        return JSON.stringify(storedCreds)
      }
      return null
    })

    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    const apiKey = await (agent as any).getApiKey('openai-codex')

    // Should be a string, not an object
    expect(typeof apiKey).toBe('string')
    expect(apiKey).toBe('acc-token-string-only')
  })
})

describe('oauth-providers: Keychain helpers', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('getKeychainCredential parses valid JSON from Keychain', async () => {
    const { getKeychainCredential } = await import('../agent/oauth-providers')

    const creds = { refresh: 'r', access: 'a', expires: 123 }
    invokeMock.mockResolvedValue(JSON.stringify(creds))

    const result = await getKeychainCredential('anthropic')
    expect(result).toEqual(creds)
    expect(invokeMock).toHaveBeenCalledWith('get_credential', { key: 'oauth:anthropic' })
  })

  it('getKeychainCredential returns null for missing credential', async () => {
    const { getKeychainCredential } = await import('../agent/oauth-providers')
    invokeMock.mockResolvedValue(null)

    const result = await getKeychainCredential('anthropic')
    expect(result).toBeNull()
  })

  it('storeKeychainCredential writes JSON to Keychain', async () => {
    const { storeKeychainCredential } = await import('../agent/oauth-providers')
    invokeMock.mockResolvedValue(undefined)

    const creds = { refresh: 'r', access: 'a', expires: 999 }
    await storeKeychainCredential('anthropic', creds)

    expect(invokeMock).toHaveBeenCalledWith('store_credential', {
      key: 'oauth:anthropic',
      value: JSON.stringify(creds),
    })
  })
})
