// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// ── Pi SDK mock with a small fake catalog ──

const catalog: Record<string, string[]> = {
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-1'],
  openai: ['gpt-5.1', 'gpt-5-mini'],
  openrouter: ['anthropic/claude-sonnet-4'],
}

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn((provider: string, modelId: string) => {
    if (!catalog[provider]?.includes(modelId)) {
      throw new Error(`unknown model: ${provider}:${modelId}`)
    }
    return { id: modelId, provider, api: 'messages' }
  }),
  getProviders: vi.fn(() => Object.keys(catalog)),
  getModels: vi.fn((provider: string) =>
    (catalog[provider] ?? []).map((id) => ({ id, name: id, provider, api: 'messages' }))
  ),
}))

describe('model-config: parse/serialize', () => {
  it('parses a valid "provider:modelId" ref', async () => {
    const { parseModelSelection } = await import('../agent/model-config')
    expect(parseModelSelection('anthropic:claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    })
  })

  it('splits on the first colon so slashed model IDs survive', async () => {
    const { parseModelSelection } = await import('../agent/model-config')
    expect(parseModelSelection('openrouter:anthropic/claude-sonnet-4')).toEqual({
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    })
  })

  it('rejects missing or malformed refs', async () => {
    const { parseModelSelection } = await import('../agent/model-config')
    expect(parseModelSelection(undefined)).toBeNull()
    expect(parseModelSelection('')).toBeNull()
    expect(parseModelSelection('anthropic')).toBeNull()
    expect(parseModelSelection(':claude-sonnet-4-6')).toBeNull()
    expect(parseModelSelection('anthropic:')).toBeNull()
  })

  it('roundtrips through serialize/parse', async () => {
    const { parseModelSelection, serializeModelSelection } = await import(
      '../agent/model-config'
    )
    const sel = { provider: 'openai', modelId: 'gpt-5.1' }
    expect(parseModelSelection(serializeModelSelection(sel))).toEqual(sel)
  })
})

describe('model-config: resolveModel', () => {
  it('resolves a valid selection', async () => {
    const { resolveModel } = await import('../agent/model-config')
    const model = resolveModel('openai:gpt-5.1')
    expect(model.provider).toBe('openai')
    expect(model.id).toBe('gpt-5.1')
  })

  it('falls back to the default model for unknown provider', async () => {
    const { resolveModel, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } = await import(
      '../agent/model-config'
    )
    const model = resolveModel('not-a-provider:whatever')
    expect(model.provider).toBe(DEFAULT_PROVIDER)
    expect(model.id).toBe(DEFAULT_MODEL_ID)
  })

  it('falls back to the default model for unknown model ID', async () => {
    const { resolveModel, DEFAULT_MODEL_ID } = await import('../agent/model-config')
    const model = resolveModel('anthropic:claude-does-not-exist')
    expect(model.id).toBe(DEFAULT_MODEL_ID)
  })

  it('falls back to the default model for missing setting', async () => {
    const { resolveModel, DEFAULT_MODEL_ID } = await import('../agent/model-config')
    expect(resolveModel(undefined).id).toBe(DEFAULT_MODEL_ID)
    expect(resolveModel(null).id).toBe(DEFAULT_MODEL_ID)
    expect(resolveModel('').id).toBe(DEFAULT_MODEL_ID)
  })
})

describe('model-config: catalog listing', () => {
  it('lists providers from the catalog', async () => {
    const { listProviders } = await import('../agent/model-config')
    expect(listProviders()).toEqual(['anthropic', 'openai', 'openrouter'])
  })

  it('lists models for a provider', async () => {
    const { listModels } = await import('../agent/model-config')
    const models = listModels('openai')
    expect(models.map((m) => m.id)).toEqual(['gpt-5.1', 'gpt-5-mini'])
  })

  it('returns empty list for unknown provider', async () => {
    const { listModels } = await import('../agent/model-config')
    expect(listModels('not-a-provider')).toEqual([])
  })
})
