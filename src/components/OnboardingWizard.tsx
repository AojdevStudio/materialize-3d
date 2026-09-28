import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth'
import '../styles/onboarding.css'

// ── Zustand store for wizard step (HMR-resilient) ──

interface OnboardingStore {
  currentStep: number
  setStep: (step: number) => void
  reset: () => void
}

export const useOnboardingStore = create<OnboardingStore>((set) => ({
  currentStep: 0,
  setStep: (step) => set({ currentStep: step }),
  reset: () => set({ currentStep: 0 }),
}))

// ── Types ──

interface ProviderState {
  connected: boolean
  loading: boolean
  status: string | null
  error: string | null
}

interface PrinterState {
  detected: boolean
  name: string | null
  loading: boolean
  connectionResult: 'success' | 'error' | null
  connectionMessage: string | null
}

interface PrinterFormData {
  accessCode: string
  host: string
  deviceId: string
}

// ── Constants ──

const STEPS = ['Welcome', 'LLM Provider', 'Bambu Printer', 'Complete'] as const
const STEP_COUNT = STEPS.length

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    desc: 'Claude Pro / Max subscription',
    icon: 'A',
    keychainKey: 'oauth:anthropic',
  },
  {
    id: 'openai-codex',
    name: 'OpenAI',
    desc: 'ChatGPT Plus / Pro subscription',
    icon: 'O',
    keychainKey: 'oauth:openai-codex',
  },
] as const

// ── Component ──

interface OnboardingWizardProps {
  onComplete: () => void
}

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { currentStep, setStep } = useOnboardingStore()

  // Provider state
  const [providers, setProviders] = useState<Record<string, ProviderState>>({
    anthropic: { connected: false, loading: false, status: null, error: null },
    'openai-codex': { connected: false, loading: false, status: null, error: null },
  })

  // Printer state
  const [printer, setPrinter] = useState<PrinterState>({
    detected: false,
    name: null,
    loading: false,
    connectionResult: null,
    connectionMessage: null,
  })

  const [printerForm, setPrinterForm] = useState<PrinterFormData>({
    accessCode: '',
    host: '',
    deviceId: '',
  })

  // ── Step navigation ──

  const nextStep = useCallback(() => {
    setStep(Math.min(currentStep + 1, STEP_COUNT - 1))
  }, [currentStep, setStep])

  // ── OAuth sign-in ──

  const handleSignIn = useCallback(
    async (providerId: string) => {
      setProviders((prev) => ({
        ...prev,
        [providerId]: { ...prev[providerId]!, loading: true, status: 'Opening browser…', error: null },
      }))

      try {
        const provider = getOAuthProvider(providerId)
        if (!provider) {
          throw new Error(`Provider ${providerId} not registered`)
        }

        console.debug('onboarding:oauth-started', providerId)

        await provider.login({
          onAuth: (info: { url: string; instructions?: string }) => {
            setProviders((prev) => ({
              ...prev,
              [providerId]: { ...prev[providerId]!, status: info.instructions ?? 'Waiting for sign-in…' },
            }))
            // System browser is opened by the provider itself via openUrl
          },
          onProgress: (message: string) => {
            setProviders((prev) => ({
              ...prev,
              [providerId]: { ...prev[providerId]!, status: message },
            }))
          },
        } as Parameters<typeof provider.login>[0])

        setProviders((prev) => ({
          ...prev,
          [providerId]: { connected: true, loading: false, status: null, error: null },
        }))
        console.debug('onboarding:oauth-complete', providerId)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sign-in failed'
        setProviders((prev) => ({
          ...prev,
          [providerId]: { connected: false, loading: false, status: null, error: message },
        }))
        console.error('onboarding:oauth-failed', providerId, err)
      }
    },
    []
  )

  // ── Printer detection on step mount ──

  useEffect(() => {
    if (currentStep !== 2) return

    let cancelled = false

    const detect = async () => {
      setPrinter((prev) => ({ ...prev, loading: true }))
      try {
        const status = await invoke<{
          isConnected: boolean
          connectionState: string
          name: string | null
        }>('get_printer_status')

        if (cancelled) return

        if (status.isConnected || status.connectionState === 'connected_mqtt') {
          setPrinter({
            detected: true,
            name: status.name ?? 'Bambu Printer',
            loading: false,
            connectionResult: null,
            connectionMessage: null,
          })
        } else {
          setPrinter((prev) => ({ ...prev, loading: false }))
        }
      } catch {
        if (!cancelled) {
          setPrinter((prev) => ({ ...prev, loading: false }))
        }
      }
    }

    void detect()
    return () => {
      cancelled = true
    }
  }, [currentStep])

  // ── Test printer connection ──

  const handleTestConnection = useCallback(async () => {
    setPrinter((prev) => ({
      ...prev,
      loading: true,
      connectionResult: null,
      connectionMessage: null,
    }))

    try {
      // Save printer form data as a PrinterConfig (persists to SQLite + Keychain)
      const config = await invoke<{
        id: string
        name: string
        host: string
        serial: string
      }>('add_printer_config', {
        name: printerForm.host || 'My Printer',
        host: printerForm.host,
        serial: printerForm.deviceId,
        accessCode: printerForm.accessCode,
      })

      // Set as default printer for auto-connect
      await invoke('set_default_printer_config', { id: config.id })

      // Connect using the saved config
      await invoke('connect_printer_by_config', { configId: config.id })

      // Wait a bit for the async MQTT connection to resolve
      await new Promise((r) => setTimeout(r, 2000))

      const status = await invoke<{
        isConnected: boolean
        connectionState: string
        name: string | null
      }>('get_printer_status')

      if (status.isConnected) {
        setPrinter({
          detected: true,
          name: status.name ?? config.name,
          loading: false,
          connectionResult: 'success',
          connectionMessage: `Connected to ${status.name ?? config.name}`,
        })
      } else {
        setPrinter((prev) => ({
          ...prev,
          loading: false,
          connectionResult: 'error',
          connectionMessage: 'Connection failed — check credentials and network.',
        }))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      setPrinter((prev) => ({
        ...prev,
        loading: false,
        connectionResult: 'error',
        connectionMessage: msg,
      }))
    }
  }, [])

  // ── Check existing provider credentials on LLM step mount ──

  useEffect(() => {
    if (currentStep !== 1) return

    let cancelled = false

    const check = async () => {
      for (const p of PROVIDERS) {
        try {
          const has = await invoke<boolean>('has_credential', { key: p.keychainKey })
          if (cancelled) return
          if (has) {
            setProviders((prev) => ({
              ...prev,
              [p.id]: { connected: true, loading: false, status: null, error: null },
            }))
          }
        } catch {
          // Ignore — credential check failed
        }
      }
    }

    void check()
    return () => {
      cancelled = true
    }
  }, [currentStep])

  // ── Handle wizard completion ──

  const handleComplete = useCallback(() => {
    useOnboardingStore.getState().reset()
    onComplete()
  }, [onComplete])

  // ── Derived state ──

  const anyProviderConnected = Object.values(providers).some((p) => p.connected)

  // ── Render steps ──

  const renderStepIndicator = () => (
    <div className="onboarding-steps" data-testid="step-indicator">
      {STEPS.map((_, i) => (
        <div
          key={i}
          className={`onboarding-step-dot${i === currentStep ? ' active' : ''}${i < currentStep ? ' completed' : ''}`}
        />
      ))}
    </div>
  )

  const renderWelcome = () => (
    <div className="onboarding-card" data-testid="step-welcome">
      <div className="onboarding-card-header">
        <span className="onboarding-kicker">Materialize 3D</span>
        <h1 className="onboarding-title">Ideas to Atoms</h1>
        <p className="onboarding-description">
          Agentic 3D printing — from idea to physical object.
          Connect your AI provider and printer to get started.
        </p>
      </div>
      <div className="onboarding-footer">
        <button
          className="onboarding-btn-primary"
          data-testid="btn-get-started"
          onClick={nextStep}
        >
          Get Started
        </button>
      </div>
    </div>
  )

  const renderLLMProvider = () => (
    <div className="onboarding-card" data-testid="step-llm">
      <div className="onboarding-card-header">
        <span className="onboarding-kicker">Step 2 of 4</span>
        <h2 className="onboarding-title">Connect an AI Provider</h2>
        <p className="onboarding-description">
          Sign in with your Anthropic or OpenAI subscription to enable AI-powered workflows.
        </p>
      </div>

      <div className="onboarding-providers">
        {PROVIDERS.map((p) => {
          const state = providers[p.id]!
          return (
            <div
              key={p.id}
              className={`provider-card${state.connected ? ' connected' : ''}`}
              data-testid={`provider-card-${p.id}`}
            >
              <div className="provider-icon">{p.icon}</div>
              <div className="provider-info">
                <div className="provider-name">{p.name}</div>
                <div className="provider-desc">{p.desc}</div>
                {state.status && <div className="provider-status">{state.status}</div>}
                {state.error && (
                  <div className="provider-status" style={{ color: 'var(--accent-red)' }}>
                    {state.error}
                  </div>
                )}
              </div>
              <div className="provider-action">
                {state.connected ? (
                  <span style={{ color: 'var(--accent-green)', fontSize: 18 }}>✓</span>
                ) : (
                  <button
                    className="onboarding-btn-secondary"
                    disabled={state.loading}
                    onClick={() => void handleSignIn(p.id)}
                    data-testid={`btn-signin-${p.id}`}
                  >
                    {state.loading ? 'Signing in…' : 'Sign in'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="onboarding-footer">
        <button
          className="onboarding-btn-primary"
          onClick={nextStep}
          data-testid="btn-llm-continue"
        >
          Continue
        </button>
        <button
          className="onboarding-skip"
          onClick={nextStep}
          data-testid="btn-llm-skip"
        >
          Skip for now
        </button>
      </div>
    </div>
  )

  const renderBambuPrinter = () => (
    <div className="onboarding-card" data-testid="step-bambu">
      <div className="onboarding-card-header">
        <span className="onboarding-kicker">Step 3 of 4</span>
        <h2 className="onboarding-title">Configure Printer</h2>
        <p className="onboarding-description">
          Connect your Bambu Lab printer for direct printing from the app.
        </p>
      </div>

      {printer.detected ? (
        <div className="onboarding-printer-status detected" data-testid="printer-detected">
          <div className="printer-status-dot green" />
          <span className="printer-status-text">Printer detected: {printer.name}</span>
        </div>
      ) : (
        <>
          <div className="onboarding-printer-status" data-testid="printer-not-detected">
            <div className={`printer-status-dot ${printer.loading ? 'green' : 'gray'}`} />
            <span className="printer-status-text">
              {printer.loading ? 'Checking…' : 'No printer detected'}
            </span>
          </div>

          <div className="onboarding-form">
            <div className="onboarding-field">
              <label className="onboarding-label" htmlFor="ob-host">Host IP</label>
              <input
                id="ob-host"
                className="onboarding-input"
                placeholder="e.g. 192.0.2.136"
                value={printerForm.host}
                onChange={(e) => setPrinterForm((f) => ({ ...f, host: e.target.value }))}
                data-testid="input-host"
              />
            </div>
            <div className="onboarding-field">
              <label className="onboarding-label" htmlFor="ob-access-code">Access Code</label>
              <input
                id="ob-access-code"
                className="onboarding-input"
                placeholder="8-digit access code"
                value={printerForm.accessCode}
                onChange={(e) => setPrinterForm((f) => ({ ...f, accessCode: e.target.value }))}
                data-testid="input-access-code"
              />
            </div>
            <div className="onboarding-field">
              <label className="onboarding-label" htmlFor="ob-device-id">Device ID</label>
              <input
                id="ob-device-id"
                className="onboarding-input"
                placeholder="e.g. 01P00A000000000"
                value={printerForm.deviceId}
                onChange={(e) => setPrinterForm((f) => ({ ...f, deviceId: e.target.value }))}
                data-testid="input-device-id"
              />
            </div>

            <button
              className="onboarding-btn-secondary"
              onClick={() => void handleTestConnection()}
              disabled={printer.loading}
              data-testid="btn-test-connection"
            >
              {printer.loading ? 'Connecting…' : 'Test Connection'}
            </button>

            {printer.connectionResult && (
              <div
                className={`onboarding-connection-result ${printer.connectionResult}`}
                data-testid="connection-result"
              >
                {printer.connectionMessage}
              </div>
            )}
          </div>
        </>
      )}

      <div className="onboarding-footer">
        <button
          className="onboarding-btn-primary"
          onClick={nextStep}
          data-testid="btn-bambu-continue"
        >
          Continue
        </button>
        <button
          className="onboarding-skip"
          onClick={nextStep}
          data-testid="btn-bambu-skip"
        >
          Skip for now
        </button>
      </div>
    </div>
  )

  const renderComplete = () => (
    <div className="onboarding-card" data-testid="step-complete">
      <div className="onboarding-card-header">
        <span className="onboarding-kicker">All set!</span>
        <h2 className="onboarding-title">Ready to Create</h2>
        <p className="onboarding-description">
          {anyProviderConnected || printer.detected
            ? 'Your setup is complete. Start creating!'
            : 'You can configure providers and printer later from settings.'}
        </p>
      </div>

      <div className="onboarding-summary" data-testid="setup-summary">
        {PROVIDERS.map((p) => {
          const state = providers[p.id]!
          return (
            <div key={p.id} className="onboarding-summary-item">
              <div className={`summary-check ${state.connected ? 'done' : 'skipped'}`}>
                {state.connected ? '✓' : '—'}
              </div>
              <span>{p.name}: {state.connected ? 'Connected' : 'Not configured'}</span>
            </div>
          )
        })}
        <div className="onboarding-summary-item">
          <div className={`summary-check ${printer.detected ? 'done' : 'skipped'}`}>
            {printer.detected ? '✓' : '—'}
          </div>
          <span>Bambu Printer: {printer.detected ? printer.name : 'Not configured'}</span>
        </div>
      </div>

      <div className="onboarding-footer">
        <button
          className="onboarding-btn-primary"
          onClick={handleComplete}
          data-testid="btn-launch-app"
        >
          Launch App
        </button>
      </div>
    </div>
  )

  const stepRenderers = [renderWelcome, renderLLMProvider, renderBambuPrinter, renderComplete]

  return (
    <div className="onboarding-overlay" data-testid="onboarding-wizard">
      <div className="onboarding-container">
        {renderStepIndicator()}
        {stepRenderers[currentStep]!()}
      </div>
    </div>
  )
}
