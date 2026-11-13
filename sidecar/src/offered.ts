/**
 * The short list the model picker offers: the newest models of each provider the app signs in to, in menu order, by
 * the short name the app shows. It imports only types, so the window's code can share it.
 */
import type { ModelChoice, ModelOption, ProviderId } from './protocol'

export const OFFERED: readonly (ModelOption & { provider: ProviderId })[] = [
  { provider: 'anthropic', modelId: 'claude-opus-5-5', name: 'Opus 5.5' },
  { provider: 'anthropic', modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { provider: 'anthropic', modelId: 'claude-fable-5-2', name: 'Fable 5.2' },
  { provider: 'openai-codex', modelId: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' },
]

/** The name the app shows for a model: its short name, or its id when the list has none, as for a model an older version saved. */
export const modelName = ({ provider, modelId }: ModelChoice): string =>
  OFFERED.find((m) => m.provider === provider && m.modelId === modelId)?.name ?? modelId
