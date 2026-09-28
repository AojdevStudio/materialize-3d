/**
 * Custom OAuth providers for Anthropic and OpenAI that use the Rust-side
 * callback server (T01) and system browser instead of Node.js http.createServer.
 *
 * Registered via Pi SDK's registerOAuthProvider() to replace built-in providers.
 */
import {
  refreshAnthropicToken,
  refreshOpenAICodexToken,
  registerOAuthProvider,
} from '@mariozechner/pi-ai/oauth'
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from '@mariozechner/pi-ai/oauth'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'

// ============================================================================
// PKCE (inlined from Pi SDK's pkce.js — not re-exported from @mariozechner/pi-ai/oauth)
// ============================================================================

/** Encode bytes as base64url string. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** Generate PKCE code verifier and challenge using Web Crypto. */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64urlEncode(verifierBytes)

  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const challenge = base64urlEncode(new Uint8Array(hashBuffer))

  return { verifier, challenge }
}

// ============================================================================
// Keychain helpers
// ============================================================================

export const KEYCHAIN_SERVICE = 'com.materialize3d'

/** Retrieve parsed OAuth credentials from macOS Keychain. */
export async function getKeychainCredential(
  provider: string
): Promise<OAuthCredentials | null> {
  const raw = await invoke<string | null>('get_credential', {
    key: `oauth:${provider}`,
  })
  if (!raw) return null
  try {
    return JSON.parse(raw) as OAuthCredentials
  } catch {
    return null
  }
}

/** Store OAuth credentials in macOS Keychain as JSON. */
export async function storeKeychainCredential(
  provider: string,
  creds: OAuthCredentials
): Promise<void> {
  await invoke('store_credential', {
    key: `oauth:${provider}`,
    value: JSON.stringify(creds),
  })
  console.debug('oauth:tokens-stored', provider)
}

// ============================================================================
// Constants — mirrored from Pi SDK source
// ============================================================================

// Anthropic
const ANTHROPIC_CLIENT_ID = atob('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl')
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const ANTHROPIC_CALLBACK_PORT = 53692
const ANTHROPIC_REDIRECT_URI = `http://localhost:${ANTHROPIC_CALLBACK_PORT}/callback`
const ANTHROPIC_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

// OpenAI Codex
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_CALLBACK_PORT = 1455
const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_CALLBACK_PORT}/auth/callback`
const OPENAI_SCOPE = 'openid profile email offline_access'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

// ============================================================================
// Shared helpers
// ============================================================================

/** Generate a random state string using Web Crypto (replaces node:crypto.randomBytes). */
function createState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Decode JWT payload (for OpenAI accountId extraction). */
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1] ?? ''
    const decoded = atob(payload)
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return null
  }
}

interface OAuthCallbackPayload {
  code: string
  state: string
}

/**
 * Listen for the Tauri `oauth:callback` event and return the code + state.
 * Returns a promise that resolves when the callback is received.
 */
function waitForOAuthCallback(): Promise<OAuthCallbackPayload> {
  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null
    listen<OAuthCallbackPayload>('oauth:callback', (event) => {
      unlisten?.()
      resolve(event.payload)
    }).then((fn) => {
      unlisten = fn
    })
  })
}

// ============================================================================
// Anthropic Provider
// ============================================================================

export const anthropicTauriProvider: OAuthProviderInterface = {
  id: 'anthropic',
  name: 'Anthropic (Claude Pro/Max)',
  usesCallbackServer: true,

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const provider = 'anthropic'
    console.debug('oauth:flow-started', provider)

    try {
      const { verifier, challenge } = await generatePKCE()

      // Build authorization URL (Anthropic uses verifier as state)
      const authParams = new URLSearchParams({
        code: 'true',
        client_id: ANTHROPIC_CLIENT_ID,
        response_type: 'code',
        redirect_uri: ANTHROPIC_REDIRECT_URI,
        scope: ANTHROPIC_SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: verifier,
      })
      const authUrl = `${ANTHROPIC_AUTHORIZE_URL}?${authParams.toString()}`

      // Start Rust callback server
      await invoke('start_oauth_callback', { port: ANTHROPIC_CALLBACK_PORT })

      // Notify UI the auth flow has started
      callbacks.onAuth({
        url: authUrl,
        instructions: 'Complete login in your browser.',
      })

      // Open system browser
      await openUrl(authUrl)

      // Wait for callback from Rust server
      const result = await waitForOAuthCallback()
      console.debug('oauth:callback-received', provider)

      // Exchange code for tokens via Rust proxy (avoids CORS blocking on token endpoints)
      const responseBody = await invoke<string>('oauth_token_exchange', {
        url: ANTHROPIC_TOKEN_URL,
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: ANTHROPIC_CLIENT_ID,
          code: result.code,
          state: result.state,
          redirect_uri: ANTHROPIC_REDIRECT_URI,
          code_verifier: verifier,
        }),
        contentType: 'application/json',
      })

      const tokenData = JSON.parse(responseBody) as {
        refresh_token: string
        access_token: string
        expires_in: number
      }

      const creds: OAuthCredentials = {
        refresh: tokenData.refresh_token,
        access: tokenData.access_token,
        expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      }

      // Persist to Keychain
      await storeKeychainCredential(provider, creds)

      return creds
    } catch (error) {
      console.error('oauth:flow-failed', provider, error)
      throw error
    }
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const creds = await refreshAnthropicToken(credentials.refresh)
    await storeKeychainCredential('anthropic', creds)
    console.debug('oauth:token-refreshed', 'anthropic')
    return creds
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  },
}

// ============================================================================
// OpenAI Codex Provider
// ============================================================================

export const openaiTauriProvider: OAuthProviderInterface = {
  id: 'openai-codex',
  name: 'ChatGPT Plus/Pro (Codex Subscription)',
  usesCallbackServer: true,

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const provider = 'openai-codex'
    console.debug('oauth:flow-started', provider)

    try {
      const { verifier, challenge } = await generatePKCE()
      const state = createState()

      // Build authorization URL
      const url = new URL(OPENAI_AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', OPENAI_CLIENT_ID)
      url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI)
      url.searchParams.set('scope', OPENAI_SCOPE)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      url.searchParams.set('id_token_add_organizations', 'true')
      url.searchParams.set('codex_cli_simplified_flow', 'true')
      url.searchParams.set('originator', 'materialize-3d')
      const authUrl = url.toString()

      // Start Rust callback server
      await invoke('start_oauth_callback', { port: OPENAI_CALLBACK_PORT })

      // Notify UI
      callbacks.onAuth({
        url: authUrl,
        instructions: 'Complete login in your browser.',
      })

      // Open system browser
      await openUrl(authUrl)

      // Wait for callback
      const result = await waitForOAuthCallback()
      console.debug('oauth:callback-received', provider)

      // Exchange code for tokens via Rust proxy (avoids CORS blocking on token endpoints)
      const responseBody = await invoke<string>('oauth_token_exchange', {
        url: OPENAI_TOKEN_URL,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OPENAI_CLIENT_ID,
          code: result.code,
          code_verifier: verifier,
          redirect_uri: OPENAI_REDIRECT_URI,
        }).toString(),
        contentType: 'application/x-www-form-urlencoded',
      })

      const json = JSON.parse(responseBody) as {
        access_token: string
        refresh_token: string
        expires_in: number
      }

      if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
        throw new Error('Token response missing required fields')
      }

      // Extract accountId from JWT
      const payload = decodeJwt(json.access_token)
      const auth = payload?.[JWT_CLAIM_PATH] as
        | { chatgpt_account_id?: string }
        | undefined
      const accountId = auth?.chatgpt_account_id
      if (!accountId) {
        throw new Error('Failed to extract accountId from token')
      }

      const creds: OAuthCredentials = {
        access: json.access_token,
        refresh: json.refresh_token,
        expires: Date.now() + json.expires_in * 1000,
        accountId,
      }

      // Persist to Keychain
      await storeKeychainCredential(provider, creds)

      return creds
    } catch (error) {
      console.error('oauth:flow-failed', provider, error)
      throw error
    }
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const creds = await refreshOpenAICodexToken(credentials.refresh)
    await storeKeychainCredential('openai-codex', creds)
    console.debug('oauth:token-refreshed', 'openai-codex')
    return creds
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access
  },
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register Tauri-native OAuth providers, replacing the built-in Node.js ones.
 * Call before agent storage init so providers are available before any agent is created.
 */
export function registerTauriOAuthProviders(): void {
  registerOAuthProvider(anthropicTauriProvider)
  registerOAuthProvider(openaiTauriProvider)
  console.debug('oauth:tauri-providers-registered')
}
