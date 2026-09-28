/**
 * Model selection for the agent.
 *
 * The agent runtime (@mariozechner/pi-ai) is provider-agnostic: getModel()
 * resolves any provider/model pair from its built-in catalog (anthropic,
 * openai, google, xai, groq, mistral, openrouter, ...). The user's selection
 * is persisted in the Rust-backed settings store under `agent.model` as a
 * "provider:modelId" string. Missing, malformed, or unknown values fall back
 * to the default Anthropic model.
 */
import { getModel, getModels, getProviders, type Model } from '@mariozechner/pi-ai'

export const AGENT_MODEL_SETTING = 'agent.model'
export const DEFAULT_PROVIDER = 'anthropic'
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6'
export const DEFAULT_MODEL_REF = `${DEFAULT_PROVIDER}:${DEFAULT_MODEL_ID}`

export interface ModelSelection {
  provider: string
  modelId: string
}

/**
 * Parse a stored "provider:modelId" setting. Splits on the FIRST colon so
 * model IDs containing slashes/colons (e.g. OpenRouter's "vendor/model")
 * survive. Returns null for missing or malformed values.
 */
export function parseModelSelection(value: string | undefined | null): ModelSelection | null {
  if (!value) return null
  const sep = value.indexOf(':')
  if (sep <= 0 || sep === value.length - 1) return null
  return { provider: value.slice(0, sep), modelId: value.slice(sep + 1) }
}

export function serializeModelSelection(sel: ModelSelection): string {
  return `${sel.provider}:${sel.modelId}`
}

// pi-ai's getModel/getModels are generically typed over literal catalog keys.
// Selection comes from user settings at runtime, so we erase the generics here
// and rely on try/catch + fallback for unknown values.
const getModelUnchecked = getModel as (provider: string, modelId: string) => Model<any> | undefined
const getModelsUnchecked = getModels as (provider: string) => Model<any>[]

/**
 * Resolve a stored "provider:modelId" setting to a pi-ai Model.
 * Falls back to the default model when the setting is missing, malformed,
 * or not present in the pi-ai catalog.
 */
export function resolveModel(value?: string | null): Model<any> {
  const sel = parseModelSelection(value)
  if (sel) {
    try {
      const model = getModelUnchecked(sel.provider, sel.modelId)
      if (model) return model
    } catch {
      console.warn('agent:unknown-model-setting', value, '— falling back to default')
    }
  }
  return getModel(DEFAULT_PROVIDER, DEFAULT_MODEL_ID)
}

/** All providers known to pi-ai's model catalog. */
export function listProviders(): string[] {
  try {
    return [...getProviders()]
  } catch {
    return [DEFAULT_PROVIDER]
  }
}

export interface ModelOption {
  id: string
  name: string
}

/** Models available for a provider in pi-ai's catalog. Empty on unknown provider. */
export function listModels(provider: string): ModelOption[] {
  try {
    return getModelsUnchecked(provider).map((m) => ({
      id: m.id,
      name: (m as { name?: string }).name ?? m.id,
    }))
  } catch {
    return []
  }
}
