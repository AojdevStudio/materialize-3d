// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

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

// ── Imports after mocks ──
import OnboardingWizard, { useOnboardingStore } from '../components/OnboardingWizard'
import App from '../App'
import { useAgentStore } from '../stores/agent'

// ── Helpers ──

/**
 * Default invoke mock: Anthropic active, basic printer status. The agent keeps
 * a key and a server address per provider, as the Rust agent does, and starts
 * with the given ones.
 */
function setupDefaultMocks(saved: { keys?: string[]; baseUrls?: Record<string, string> } = {}) {
  const models: Record<string, string[]> = { anthropic: ['claude-opus-5-5', 'claude-fable-5-1'], openai: ['gpt-6-astra', 'gpt-6.1-sol'] }
  const keys = new Set(saved.keys)
  const baseUrls = new Map(Object.entries(saved.baseUrls ?? {}))
  let active = { provider: 'anthropic', model: 'claude-opus-5-5' }
  const agent = () => ({
    ...active,
    models: models[active.provider]!,
    hasApiKey: keys.has(active.provider),
    baseUrl: baseUrls.get(active.provider) ?? null,
  })
  invokeMock.mockImplementation(async (cmd: string, payload?: any) => {
    if (cmd === 'agent_status') return agent()
    if (cmd === 'agent_set_model') {
      active = { provider: payload.provider, model: payload.model || models[payload.provider]![0]! }
      return agent()
    }
    if (cmd === 'agent_set_base_url') {
      if (payload.baseUrl) baseUrls.set(payload.provider, payload.baseUrl)
      else baseUrls.delete(payload.provider)
      return agent()
    }
    if (cmd === 'agent_set_api_key') {
      keys.add(payload.provider)
      return agent()
    }
    if (cmd === 'agent_history') return { conversationId: 'c1', entries: [] }
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
    useAgentStore.setState({ status: null })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
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

  it('LLM step stores the chosen provider and API key on Continue', async () => {
    const onComplete = vi.fn()
    useOnboardingStore.getState().setStep(1)
    render(<OnboardingWizard onComplete={onComplete} />)

    expect(screen.getByTestId('provider-anthropic')).toBeDefined()
    fireEvent.click(screen.getByTestId('provider-openai'))
    const input = screen.getByTestId('input-api-key') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByTestId('btn-llm-continue'))

    await waitFor(() => expect(screen.getByTestId('step-bambu')).toBeDefined())
    expect(invokeMock).toHaveBeenCalledWith('agent_set_model', { provider: 'openai', model: '' })
    expect(invokeMock).toHaveBeenCalledWith('agent_set_api_key', { provider: 'openai', apiKey: 'sk-test' })
  })

  it('LLM step stores a typed server address on Continue', async () => {
    useOnboardingStore.getState().setStep(1)
    render(<OnboardingWizard onComplete={vi.fn()} />)

    fireEvent.change(screen.getByTestId('input-base-url'), { target: { value: 'https://gateway.example/v1' } })
    fireEvent.change(screen.getByTestId('input-api-key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByTestId('btn-llm-continue'))

    await waitFor(() => expect(screen.getByTestId('step-bambu')).toBeDefined())
    expect(invokeMock).toHaveBeenCalledWith('agent_set_base_url', { provider: 'anthropic', baseUrl: 'https://gateway.example/v1' })
    expect(invokeMock).toHaveBeenCalledWith('agent_set_api_key', { provider: 'anthropic', apiKey: 'sk-test' })
  })

  it('LLM step stores a changed address alone when the key is already stored', async () => {
    setupDefaultMocks({ keys: ['anthropic'] })
    useOnboardingStore.getState().setStep(1)
    render(<OnboardingWizard onComplete={vi.fn()} />)

    await screen.findByTestId('api-key-stored')
    fireEvent.change(screen.getByTestId('input-base-url'), { target: { value: 'https://gateway.example/v1' } })
    fireEvent.click(screen.getByTestId('btn-llm-continue'))

    await waitFor(() => expect(screen.getByTestId('step-bambu')).toBeDefined())
    expect(useAgentStore.getState().status).toMatchObject({ provider: 'anthropic', baseUrl: 'https://gateway.example/v1' })
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'agent_set_api_key')).toHaveLength(0)
  })

  it('LLM step shows the active provider\'s saved address and an empty one for another provider', async () => {
    setupDefaultMocks({ baseUrls: { anthropic: 'https://gateway.example/v1' } })
    useOnboardingStore.getState().setStep(1)
    render(<OnboardingWizard onComplete={vi.fn()} />)

    const address = screen.getByTestId('input-base-url') as HTMLInputElement
    await waitFor(() => expect(address.value).toBe('https://gateway.example/v1'))
    fireEvent.click(screen.getByTestId('provider-openai'))
    expect(address.value).toBe('')
    fireEvent.click(screen.getByTestId('provider-anthropic'))
    expect(address.value).toBe('https://gateway.example/v1')
  })

  it('LLM step sends a new key where the address field says, not to a hidden saved gateway', async () => {
    setupDefaultMocks({ baseUrls: { openai: 'https://old-gateway.example/v1' } })
    useOnboardingStore.getState().setStep(1)
    render(<OnboardingWizard onComplete={vi.fn()} />)

    await waitFor(() => expect(useAgentStore.getState().status?.provider).toBe('anthropic'))
    fireEvent.click(screen.getByTestId('provider-openai'))
    expect((screen.getByTestId('input-base-url') as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByTestId('input-api-key'), { target: { value: 'sk-new' } })
    fireEvent.click(screen.getByTestId('btn-llm-continue'))

    await waitFor(() => expect(screen.getByTestId('step-bambu')).toBeDefined())
    expect(useAgentStore.getState().status).toMatchObject({ provider: 'openai', hasApiKey: true, baseUrl: null })
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

  it('tests the typed printer values using the registered default-printer command', async () => {
    vi.useFakeTimers()
    let connected = false
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case 'get_printer_status':
          return { isConnected: connected, connectionState: connected ? 'connected_mqtt' : 'disconnected', name: null }
        case 'add_printer_config':
          return { id: 'printer-test', name: 'Test printer', host: '192.0.2.10', serial: 'TEST-SERIAL' }
        case 'set_default_printer':
          return undefined
        case 'connect_printer_by_config':
          connected = true
          return undefined
        default:
          throw new Error(`Unknown command: ${cmd}`)
      }
    })
    useOnboardingStore.getState().setStep(2)
    await act(async () => {
      render(<OnboardingWizard onComplete={vi.fn()} />)
    })
    fireEvent.change(screen.getByTestId('input-host'), { target: { value: '192.0.2.10' } })
    fireEvent.change(screen.getByTestId('input-access-code'), { target: { value: '12345678' } })
    fireEvent.change(screen.getByTestId('input-device-id'), { target: { value: 'TEST-SERIAL' } })

    await act(async () => {
      fireEvent.click(screen.getByTestId('btn-test-connection'))
    })

    expect(invokeMock).toHaveBeenCalledWith('add_printer_config', {
      name: '192.0.2.10', host: '192.0.2.10', serial: 'TEST-SERIAL', accessCode: '12345678',
    })
    expect(invokeMock).toHaveBeenCalledWith('set_default_printer', { id: 'printer-test' })
    expect(invokeMock).toHaveBeenCalledWith('connect_printer_by_config', { configId: 'printer-test' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(screen.getByTestId('printer-detected').textContent).toContain('Test printer')
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'add_printer_config')).toHaveLength(1)
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
    expect(summary.textContent).toContain('AI provider: Not configured')
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
