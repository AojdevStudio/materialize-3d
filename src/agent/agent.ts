import { Agent } from '@mariozechner/pi-agent-core'
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth'
import { defaultConvertToLlm } from '@mariozechner/pi-web-ui'
import { SYSTEM_PROMPT, buildDynamicContext } from './context'
import { agentTools } from './tools'
import { getAgentStorage } from './storage'
import { getKeychainCredential } from './oauth-providers'
import { AGENT_MODEL_SETTING, DEFAULT_MODEL_REF, resolveModel } from './model-config'
import { useSettingsStore } from '../stores/settings'

// ─── Singleton ────────────────────────────────────────────────────────────────

let agentInstance: Agent | null = null

/**
 * Get the singleton Agent instance, creating it lazily on first call.
 *
 * This allows the notification listener (outside React) to reach the agent
 * without needing a React context or prop chain.
 */
export function getAgent(): Agent {
  if (!agentInstance) {
    agentInstance = _createAgent()
  }
  return agentInstance
}

/**
 * Clear the cached singleton. Next `getAgent()` call creates a fresh instance.
 * Intended for test cleanup.
 */
export function resetAgent(): void {
  agentInstance = null
}

// ─── Internal Factory ─────────────────────────────────────────────────────────

/**
 * Create and configure a Materialize 3D agent instance.
 *
 * The agent:
 * - Uses the model selected in Settings (`agent.model` as "provider:modelId"),
 *   defaulting to Claude Sonnet 4; any pi-ai catalog provider works
 * - Has 11 tools wired to Tauri commands
 * - Refreshes system prompt with live printer/workspace state before each turn
 * - Picks up model changes from Settings on the next turn (no restart needed)
 * - Resolves API keys from Keychain first (with auto-refresh), then IndexedDB fallback
 */
function _createAgent(): Agent {
  // "provider:modelId" ref of the model currently applied to the agent
  let appliedModelRef = selectedModelRef()

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: resolveModel(appliedModelRef),
      tools: agentTools,
      messages: [],
    },
    convertToLlm: defaultConvertToLlm,
    getApiKey: async (provider: string) => {
      // 1. Try Keychain first
      try {
        const creds = await getKeychainCredential(provider)
        if (creds) {
          // Check expiry and auto-refresh if needed
          if (Date.now() >= creds.expires) {
            const oauthProvider = getOAuthProvider(provider)
            if (oauthProvider) {
              try {
                const refreshed = await oauthProvider.refreshToken(creds)
                // Custom provider's refreshToken already persists to Keychain
                console.debug('oauth:token-refreshed', provider)
                return oauthProvider.getApiKey(refreshed)
              } catch (refreshError) {
                console.error('oauth:refresh-failed', provider, refreshError)
                // Fall through to return stale key or try IndexedDB
              }
            }
          }
          // Return the access token from Keychain credentials
          const oauthProvider = getOAuthProvider(provider)
          if (oauthProvider) {
            return oauthProvider.getApiKey(creds)
          }
          // Fallback: return access field directly
          return creds.access
        }
      } catch {
        // Keychain not available (e.g. browser dev mode) — fall through
      }

      // 2. Fallback to IndexedDB
      try {
        const storage = getAgentStorage()
        return (await storage.providerKeys.get(provider)) ?? undefined
      } catch {
        // Storage not initialized yet — no key available
        return undefined
      }
    },
  })

  // Refresh dynamic context and sync the selected model before each LLM turn
  agent.subscribe((event) => {
    if (event.type === 'turn_start') {
      agent.setSystemPrompt(SYSTEM_PROMPT + '\n\n' + buildDynamicContext())

      // Apply model changes from Settings without recreating the agent
      const ref = selectedModelRef()
      if (ref !== appliedModelRef) {
        appliedModelRef = ref
        agent.setModel(resolveModel(ref))
        console.debug('agent:model-changed', ref)
      }
    }
  })

  return agent
}

/** Read the persisted model selection from the settings store ("provider:modelId"). */
function selectedModelRef(): string {
  return useSettingsStore.getState().getSetting(AGENT_MODEL_SETTING) ?? DEFAULT_MODEL_REF
}
