/**
 * The short list the model picker offers. It holds the newest models of each provider the app signs in to. The rows
 * are in menu order, with the short name the app shows. This file imports only types, so the window can share it.
 */
import type { ModelChoice, ModelOption, ProviderId } from './protocol'

export const OFFERED: readonly (ModelOption & { provider: ProviderId })[] = [
  { provider: 'anthropic', modelId: 'claude-opus-5-5', name: 'Opus 5.5', description: 'Best for design and checks. Recommended.' },
  { provider: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Faster, a little less careful.' },
  { provider: 'anthropic', modelId: 'claude-fable-5-2', name: 'Fable 5.2', description: 'Strong at explaining and writing guides.' },
  { provider: 'openai-codex', modelId: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', description: 'Use GPT as the main agent instead.' },
  { provider: 'opencode-go', modelId: 'glm-5.3', name: 'GLM 5.3', description: 'An open model on your OpenCode Go plan.' },
  { provider: 'opencode-go', modelId: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', description: 'An open model on your OpenCode Go plan.' },
]

/**
 * The name the app shows for a model. It is the short name, or the id when the list has none. A model that an older
 * version saved can be such a model.
 */
export const modelName = ({ provider, modelId }: ModelChoice): string =>
  OFFERED.find((m) => m.provider === provider && m.modelId === modelId)?.name ?? modelId
