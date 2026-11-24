/**
 * The app's model catalog: each model family it offers, with every version the app knows, newest first. Each ID here
 * was checked against its provider and a real account, so a new version comes with an app release. The picker offers
 * the newest version of each family that its provider has not retired, for both roles. A chat keeps the versions it
 * saved while they run. This file imports only the protocol, which imports nothing, so the window can share it.
 */
import { ASTRA_MODEL, DEFAULT_PROVIDER, type ModelChoice, type ModelOption, type ProviderId } from './protocol'

/** A model family: its provider, the short name and one line the app shows, and its versions, newest first. */
export type Family = { provider: ProviderId; name: string; description: string; versions: readonly { modelId: string; name: string }[] }

/** The families in menu order. `lead` and `helper` index the families whose newest version a new chat starts with. */
export type Catalog = { families: readonly Family[]; lead: number; helper: number }

/** The model a new install runs on as its lead. The catalog's lead family starts with it. */
export const DEFAULT_MODEL = { provider: DEFAULT_PROVIDER, modelId: 'claude-opus-5-5' } as const satisfies ModelChoice

export const CATALOG: Catalog = {
  families: [
    { provider: DEFAULT_MODEL.provider, name: 'Opus', description: 'Best for design and checks. Recommended.', versions: [{ modelId: DEFAULT_MODEL.modelId, name: 'Opus 5.5' }] },
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

/** How the store records a retired version: by `provider/modelId`, with the time its provider's removal was confirmed. */
export type RetiredVersions = Readonly<Record<string, number>>

export const versionKey = ({ provider, modelId }: ModelChoice) => `${provider}/${modelId}`

const option = (family: Family, version: Family['versions'][number]): ModelOption => ({
  provider: family.provider,
  modelId: version.modelId,
  name: version.name,
  description: family.description,
})

/** A family's newest version its provider has not retired, or undefined when it retired them all. */
export function newest(family: Family, retired: RetiredVersions): ModelOption | undefined {
  const version = family.versions.find((v) => retired[versionKey({ provider: family.provider, modelId: v.modelId })] === undefined)
  return version === undefined ? undefined : option(family, version)
}

/** The newest version of each family, in menu order. Logins filters it down to the models the person can run. */
export const offered = (catalog: Catalog, retired: RetiredVersions): ModelOption[] => catalog.families.flatMap((family) => newest(family, retired) ?? [])

const familyOf = (catalog: Catalog, { provider, modelId }: ModelChoice) =>
  catalog.families.find((family) => family.provider === provider && family.versions.some((v) => v.modelId === modelId))

/** What takes a retired version's place: the newest version of its family still offered, or null. */
export function replacementFor(catalog: Catalog, model: ModelChoice, retired: RetiredVersions): ModelChoice | null {
  const family = familyOf(catalog, model)
  const next = family === undefined ? undefined : newest(family, retired)
  return next === undefined ? null : { provider: next.provider, modelId: next.modelId }
}

/**
 * The name the app shows for a model: its version's short name in any family, or the id when the catalog has none, as
 * for a model an older version saved.
 */
export const modelName = (model: ModelChoice, catalog: Catalog = CATALOG): string =>
  familyOf(catalog, model)?.versions.find((v) => v.modelId === model.modelId)?.name ?? model.modelId
