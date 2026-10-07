import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { AgentStatus, Provider } from '../types/agent'

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
}

export const PROVIDERS = Object.keys(PROVIDER_LABELS) as Provider[]

interface AgentStore {
  /** null until the first agent_status call returns. */
  status: AgentStatus | null
  refresh: () => Promise<AgentStatus>
  setApiKey: (provider: Provider, apiKey: string) => Promise<AgentStatus>
  clearApiKey: (provider: Provider) => Promise<AgentStatus>
  setModel: (provider: Provider, model: string) => Promise<AgentStatus>
}

/**
 * Mirror of the Rust agent's settings. The Rust agent owns the offered models
 * (status.models, default first) and the active choice; setModel with an empty
 * model picks the provider's default. Every command returns the fresh
 * AgentStatus, so each call replaces the stored copy; errors propagate to the
 * caller, which shows them next to the control that failed.
 */
export const useAgentStore = create<AgentStore>()((set) => {
  const apply = async (call: Promise<AgentStatus>) => {
    const status = await call
    set({ status })
    return status
  }
  return {
    status: null,
    refresh: () => apply(invoke<AgentStatus>('agent_status')),
    setApiKey: (provider, apiKey) => apply(invoke<AgentStatus>('agent_set_api_key', { provider, apiKey })),
    clearApiKey: (provider) => apply(invoke<AgentStatus>('agent_clear_api_key', { provider })),
    setModel: (provider, model) => apply(invoke<AgentStatus>('agent_set_model', { provider, model })),
  }
})

const capitalize = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

/** "claude-opus-5-5" -> "Opus 5.5", "gpt-6.1-sol" -> "GPT-6.1 Sol"; unknown ids are shown as-is. */
export function modelLabel(model: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model)
  if (claude) {
    const [, family, major, minor] = claude
    return `${capitalize(family!)} ${major}${minor ? `.${minor}` : ''}`
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(model)
  if (gpt) {
    const [, version, name] = gpt
    return `GPT-${version} ${capitalize(name!)}`
  }
  return model
}
