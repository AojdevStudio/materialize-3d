/**
 * The app's model catalog: each model family it offers, with every version the app knows, newest first. Each ID here
 * was checked against its provider and a real account, so a new version comes with an app release. The picker offers
 * the newest version of each family, for both roles. A chat keeps the versions it saved while they run. This file imports only the protocol, which imports nothing, so the window can share it.
 */
import { ASTRA_MODEL, DEFAULT_PROVIDER, type ModelChoice, type ModelOption, type ProviderId } from './protocol'

type Version = { modelId: string; name: string }

/** A model family: its provider, the short name and one line the app shows, and its versions, newest first. */
export type Family = { provider: ProviderId; name: string; description: string; versions: readonly [Version, ...Version[]] }

/** The families in menu order. `lead` and `helper` index the families whose newest version a new chat starts with. */
export type Catalog = { families: readonly Family[]; lead: number; helper: number }

const OPUS: Family = { provider: DEFAULT_PROVIDER, name: 'Opus', description: 'Best for design and checks. Recommended.', versions: [{ modelId: 'claude-opus-5-5', name: 'Opus 5.5' }] }

/** The lead a new install starts on: the newest Opus, the catalog's lead family. */
export const DEFAULT_MODEL: ModelChoice = { provider: OPUS.provider, modelId: OPUS.versions[0].modelId }

export const CATALOG: Catalog = {
  families: [
    OPUS,
    { provider: 'anthropic', name: 'Sonnet', description: 'Faster, a little less careful.', versions: [{ modelId: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }] },
    { provider: 'anthropic', name: 'Fable', description: 'Strong at explaining and writing guides.', versions: [{ modelId: 'claude-fable-5-2', name: 'Fable 5.2' }] },
    { provider: 'openai-codex', name: 'GPT Sol', description: 'Use GPT as the main agent instead.', versions: [{ modelId: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' }] },
    { provider: ASTRA_MODEL.provider, name: 'Astra', description: 'GPT on your ChatGPT plan, good for drawings.', versions: [{ modelId: ASTRA_MODEL.modelId, name: 'Astra' }] },
    { provider: 'opencode-go', name: 'GLM', description: 'An open model on your OpenCode Go plan.', versions: [{ modelId: 'glm-5.3', name: 'GLM 5.3' }] },
    { provider: 'opencode-go', name: 'Kimi', description: 'An open model on your OpenCode Go plan.', versions: [{ modelId: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' }] },
  ],
  lead: 0,
  helper: 4,
}

/** A family's newest version, as the picker offers it. */
export const newest = (family: Family): ModelOption => ({
  provider: family.provider,
  modelId: family.versions[0].modelId,
  name: family.versions[0].name,
  description: family.description,
})

/** The newest version of each family, in menu order. Logins filters it down to the models the person can run. */
export const offered = (catalog: Catalog): ModelOption[] => catalog.families.map(newest)

const familyOf = (catalog: Catalog, { provider, modelId }: ModelChoice) =>
  catalog.families.find((family) => family.provider === provider && family.versions.some((v) => v.modelId === modelId))

/** What takes a removed version's place: the newest version of its family, or null when that is the removed one. */
export function replacementFor(catalog: Catalog, model: ModelChoice): ModelChoice | null {
  const family = familyOf(catalog, model)
  if (family === undefined || family.versions[0].modelId === model.modelId) return null
  return { provider: family.provider, modelId: family.versions[0].modelId }
}

/**
 * The name the app shows for a model: its version's short name in any family, or the id when the catalog has none, as
 * for a model an older version saved.
 */
export const modelName = (model: ModelChoice, catalog: Catalog = CATALOG): string =>
  familyOf(catalog, model)?.versions.find((v) => v.modelId === model.modelId)?.name ?? model.modelId
