// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

// ── Tauri mocks (vi.hoisted so they're available when vi.mock factories run) ──
const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  getOAuthProvider: vi.fn(() => null),
  registerOAuthProvider: vi.fn(),
  refreshAnthropicToken: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
  resetOAuthProviders: vi.fn(),
}))

// Mock pi-web-ui (needed by ChatPanel in AppLayout)
vi.mock('@mariozechner/pi-web-ui', () => {
  function MockChatPanel() {
    const el = document.createElement('div')
    el.setAttribute('data-testid', 'pi-chat-panel')
    ;(el as any).setAgent = vi.fn()
    return el
  }
  return {
    ChatPanel: MockChatPanel,
    ApiKeyPromptDialog: { prompt: vi.fn().mockResolvedValue(true) },
    defaultConvertToLlm: vi.fn((m: unknown[]) => m),
    AppStorage: vi.fn(),
    IndexedDBStorageBackend: vi.fn(),
    SettingsStore: vi.fn(() => ({ getConfig: vi.fn(), setBackend: vi.fn() })),
    ProviderKeysStore: vi.fn(() => ({ getConfig: vi.fn(), setBackend: vi.fn(), get: vi.fn() })),
    SessionsStore: Object.assign(vi.fn(() => ({ getConfig: vi.fn(), setBackend: vi.fn() })), {
      getMetadataConfig: vi.fn(),
    }),
    CustomProvidersStore: vi.fn(() => ({ getConfig: vi.fn(), setBackend: vi.fn() })),
    setAppStorage: vi.fn(),
  }
})

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(() => ({ id: 'test', provider: 'test', api: 'messages' })),
  getProviders: vi.fn(() => ['anthropic', 'openai']),
  getModels: vi.fn(() => [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4', provider: 'anthropic', api: 'messages' },
  ]),
}))

// ── Imports after mocks ──
import OnboardingWizard, { useOnboardingStore } from '../components/OnboardingWizard'
import App from '../App'

// ── Helpers ──

/** Default invoke mock: no credentials, basic printer status */
function setupDefaultMocks() {
  invokeMock.mockImplementation(async (cmd: string, payload?: any) => {
    if (cmd === 'has_credential') return false
    if (cmd === 'get_credential') return null
    if (cmd === 'get_settings') return {} // No onboarding.completed
    if (cmd === 'get_app_state') {
      return {
        printer: {
          isConnected: false,
          connectionType: null,
          connectionState: 'disconnected',
          name: null,
          nozzleTemp: null,
          nozzleTargetTemp: null,
          bedTemp: null,
          bedTargetTemp: null,
          chamberTemp: null,
          gcodeState: null,
          printProgress: null,
          remainingTime: null,
          layerNum: null,
          totalLayerNum: null,
          subtaskName: null,
          wifiSignal: null,
          amsState: [],
          lastError: null,
        },
        workspace: {
          activeModel: null,
          activeView: 'preview',
          makerworld: {
            currentUrl: 'https://makerworld.com/en',
            pageKind: 'home',
            detectedModel: null,
            importStatus: 'idle',
            importedFiles: [],
            lastExtractionError: null,
          },
        },
      }
    }
    if (cmd === 'get_printer_status') {
      return {
        isConnected: false,
        connectionState: 'disconnected',
        name: null,
      }
    }
    if (cmd === 'connect_printer') return {}
    return undefined
  })
}

describe('OnboardingWizard', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    setupDefaultMocks()
    // Reset wizard step to 0
    useOnboardingStore.getState().reset()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders with Welcome step visible on mount', () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} />)

    expect(screen.getByTestId('step-welcome')).toBeDefined()
    expect(screen.getByText('Ideas to Atoms')).toBeDefined()
    expect(screen.getByTestId('btn-get-started')).toBeDefined()
  })

  it('"Get Started" advances to LLM Provider step', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} />)

    fireEvent.click(screen.getByTestId('btn-get-started'))

    await waitFor(() => {
      expect(screen.getByTestId('step-llm')).toBeDefined()
    })
  })

  it('LLM Provider step shows Anthropic and OpenAI cards', async () => {
    const onComplete = vi.fn()
    useOnboardingStore.getState().setStep(1)
    render(<OnboardingWizard onComplete={onComplete} />)

    await waitFor(() => {
      expect(screen.getByTestId('provider-card-anthropic')).toBeDefined()
      expect(screen.getByTestId('provider-card-openai-codex')).toBeDefined()
    })
  })

  it('"Skip" on LLM step advances to Bambu step', async () => {
    const onComplete = vi.fn()
    useOnboardingStore.getState().setStep(1)
    render(<OnboardingWizard onComplete={onComplete} />)

    await waitFor(() => {
      expect(screen.getByTestId('btn-llm-skip')).toBeDefined()
    })
    fireEvent.click(screen.getByTestId('btn-llm-skip'))

    await waitFor(() => {
      expect(screen.getByTestId('step-bambu')).toBeDefined()
    })
  })

  it('"Skip" on Bambu step advances to Complete step', async () => {
    const onComplete = vi.fn()
    useOnboardingStore.getState().setStep(2)
    render(<OnboardingWizard onComplete={onComplete} />)

    await waitFor(() => {
      expect(screen.getByTestId('btn-bambu-skip')).toBeDefined()
    })
    fireEvent.click(screen.getByTestId('btn-bambu-skip'))

    await waitFor(() => {
      expect(screen.getByTestId('step-complete')).toBeDefined()
    })
  })

  it('"Launch App" on Complete step calls onComplete', async () => {
    const onComplete = vi.fn()
    useOnboardingStore.getState().setStep(3)
    render(<OnboardingWizard onComplete={onComplete} />)

    await waitFor(() => {
      expect(screen.getByTestId('btn-launch-app')).toBeDefined()
    })
    fireEvent.click(screen.getByTestId('btn-launch-app'))

    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('Complete step shows summary of configured providers', async () => {
    const onComplete = vi.fn()
    useOnboardingStore.getState().setStep(3)
    render(<OnboardingWizard onComplete={onComplete} />)

    await waitFor(() => {
      expect(screen.getByTestId('setup-summary')).toBeDefined()
    })

    const summary = screen.getByTestId('setup-summary')
    expect(summary.textContent).toContain('Anthropic')
    expect(summary.textContent).toContain('OpenAI')
    expect(summary.textContent).toContain('Bambu Printer')
  })

  it('navigates full flow: Welcome → LLM → Bambu → Complete → Launch', async () => {
    const onComplete = vi.fn()
    render(<OnboardingWizard onComplete={onComplete} />)

    // Welcome → LLM
    fireEvent.click(screen.getByTestId('btn-get-started'))
    await waitFor(() => expect(screen.getByTestId('step-llm')).toBeDefined())

    // LLM → Bambu (skip)
    fireEvent.click(screen.getByTestId('btn-llm-skip'))
    await waitFor(() => expect(screen.getByTestId('step-bambu')).toBeDefined())

    // Bambu → Complete (skip)
    fireEvent.click(screen.getByTestId('btn-bambu-skip'))
    await waitFor(() => expect(screen.getByTestId('step-complete')).toBeDefined())

    // Complete → Launch
    fireEvent.click(screen.getByTestId('btn-launch-app'))
    expect(onComplete).toHaveBeenCalledOnce()
  })
})

describe('App: onboarding gate', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    useOnboardingStore.getState().reset()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows wizard when onboarding.completed is not set', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return {} // No onboarding.completed key
      if (cmd === 'get_app_state') {
        return {
          printer: {
            isConnected: false, connectionType: null, connectionState: 'disconnected',
            name: null, nozzleTemp: null, nozzleTargetTemp: null, bedTemp: null,
            bedTargetTemp: null, chamberTemp: null, gcodeState: null, printProgress: null,
            remainingTime: null, layerNum: null, totalLayerNum: null, subtaskName: null,
            wifiSignal: null, amsState: [], lastError: null,
          },
          workspace: {
            activeModel: null, activeView: 'preview',
            makerworld: {
              currentUrl: 'https://makerworld.com/en', pageKind: 'home',
              detectedModel: null, importStatus: 'idle', importedFiles: [],
              lastExtractionError: null,
            },
          },
        }
      }
      return undefined
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-wizard')).toBeDefined()
    })
  })

  it('shows AppLayout when onboarding.completed is true', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_settings') return { 'onboarding.completed': 'true' }
      if (cmd === 'get_app_state') {
        return {
          printer: {
            isConnected: false, connectionType: null, connectionState: 'disconnected',
            name: null, nozzleTemp: null, nozzleTargetTemp: null, bedTemp: null,
            bedTargetTemp: null, chamberTemp: null, gcodeState: null, printProgress: null,
            remainingTime: null, layerNum: null, totalLayerNum: null, subtaskName: null,
            wifiSignal: null, amsState: [], lastError: null,
          },
          workspace: {
            activeModel: null, activeView: 'preview',
            makerworld: {
              currentUrl: 'https://makerworld.com/en', pageKind: 'home',
              detectedModel: null, importStatus: 'idle', importedFiles: [],
              lastExtractionError: null,
            },
          },
        }
      }
      return undefined
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Materialize')).toBeDefined()
    })

    // Wizard should NOT be present
    expect(screen.queryByTestId('onboarding-wizard')).toBeNull()
  })
})
