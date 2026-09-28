// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

// ── Mocks ──

// Track setAgent calls
const mockSetAgent = vi.fn().mockResolvedValue(undefined)

// Mock pi-web-ui: ChatPanel returns a real HTMLElement (jsdom needs real Nodes),
// ApiKeyPromptDialog with a static prompt method
vi.mock('@mariozechner/pi-web-ui', () => {
  // The mock ChatPanel creates a real DOM element and attaches setAgent to it
  function MockChatPanel() {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'pi-chat-panel')
    el.setAttribute('data-component', 'chat-panel')
    ;(el as any).setAgent = async (agent: any, config?: any) => {
      ;(el as any).agent = agent
      mockSetAgent(agent, config)
    }
    return el
  }

  return {
    ChatPanel: MockChatPanel,
    ApiKeyPromptDialog: {
      prompt: vi.fn().mockResolvedValue(true),
    },
    defaultConvertToLlm: vi.fn((messages: unknown[]) => messages),
    AppStorage: vi.fn(),
    IndexedDBStorageBackend: vi.fn(),
    SettingsStore: vi.fn(() => ({ getConfig: vi.fn() })),
    ProviderKeysStore: vi.fn(() => ({ getConfig: vi.fn(), get: vi.fn() })),
    SessionsStore: Object.assign(vi.fn(() => ({ getConfig: vi.fn() })), {
      getMetadataConfig: vi.fn(),
    }),
    CustomProvidersStore: vi.fn(() => ({ getConfig: vi.fn() })),
    setAppStorage: vi.fn(),
  }
})

// Mock the agent module
const mockAgent = {
  state: {
    model: { id: 'claude-sonnet-4-6', provider: 'anthropic', api: 'messages' },
    tools: [],
    messages: [],
    systemPrompt: 'test prompt',
  },
  subscribe: vi.fn(),
  setSystemPrompt: vi.fn(),
}

vi.mock('../agent/agent', () => ({
  getAgent: vi.fn(() => mockAgent),
}))

// Mock pi-ai (needed transitively)
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn((_provider: string, _modelId: string) => ({
    id: _modelId,
    provider: _provider,
    api: 'messages',
  })),
}))

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

describe('ChatPanel wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Ensure clean state
    delete (globalThis as any).__MATERIALIZE_AGENT__
  })

  afterEach(() => {
    cleanup()
    delete (globalThis as any).__MATERIALIZE_AGENT__
  })

  it('mounts and creates a container element with pi-chat-container class', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    render(<ChatPanel />)

    const container = document.querySelector('.pi-chat-container')
    expect(container).toBeTruthy()
    expect(container?.classList.contains('dark')).toBe(true)
  })

  it('renders header with "AI Assistant" title', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    render(<ChatPanel />)

    const title = screen.getByText('AI Assistant')
    expect(title).toBeTruthy()
    expect(title.tagName).toBe('H2')
    expect(title.classList.contains('chat-title')).toBe(true)
  })

  it('renders provider badge with provider name from agent model', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    render(<ChatPanel />)

    // Wait for the async mount to complete and update state
    await waitFor(() => {
      const badge = screen.getByText('Anthropic')
      expect(badge).toBeTruthy()
      expect(badge.classList.contains('provider-badge')).toBe(true)
    })
  })

  it('calls getAgent and setAgent on mount', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    const { getAgent } = await import('../agent/agent')
    render(<ChatPanel />)

    await waitFor(() => {
      expect(getAgent).toHaveBeenCalled()
      expect(mockSetAgent).toHaveBeenCalledWith(
        mockAgent,
        expect.objectContaining({
          onApiKeyRequired: expect.any(Function),
        })
      )
    })
  })

  it('appends Lit panel element to container on mount', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    render(<ChatPanel />)

    await waitFor(() => {
      const container = document.querySelector('.pi-chat-container')
      const litPanel = container?.querySelector('[data-testid="pi-chat-panel"]')
      expect(litPanel).toBeTruthy()
    })
  })

  it('unmounting cleans up (no orphaned Lit elements)', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    const { unmount } = render(<ChatPanel />)

    // Wait for mount to complete
    await waitFor(() => {
      const container = document.querySelector('.pi-chat-container')
      expect(container?.querySelector('[data-testid="pi-chat-panel"]')).toBeTruthy()
    })

    // Unmount and verify cleanup
    unmount()

    // The pi-chat-container itself is removed from DOM by React
    const containers = document.querySelectorAll('.pi-chat-container')
    expect(containers.length).toBe(0)

    // No orphaned pi-chat-panel elements anywhere in the document
    const orphanedPanels = document.querySelectorAll('[data-testid="pi-chat-panel"]')
    expect(orphanedPanels.length).toBe(0)
  })

  it('sets window.__MATERIALIZE_AGENT__ in dev mode', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    render(<ChatPanel />)

    await waitFor(() => {
      // Vitest runs with import.meta.env.DEV = true by default
      expect((globalThis as any).__MATERIALIZE_AGENT__).toBeDefined()
      expect((globalThis as any).__MATERIALIZE_AGENT__).toBe(mockAgent)
    })
  })

  it('chat panel is inside chat-panel aside element', async () => {
    const { ChatPanel } = await import('../components/ChatPanel')
    render(<ChatPanel />)

    const aside = document.querySelector('aside.chat-panel')
    expect(aside).toBeTruthy()
    expect(aside?.getAttribute('aria-label')).toBe('AI assistant panel')

    const container = aside?.querySelector('.pi-chat-container')
    expect(container).toBeTruthy()
  })
})
