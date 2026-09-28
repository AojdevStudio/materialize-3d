import { useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { PROVIDERS, PROVIDER_LABELS, PROVIDER_MODELS, useAgentStore } from '../stores/agent'
import type { Provider } from '../types/agent'
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

interface LlmState {
  provider: Provider
  apiKey: string
  saving: boolean
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

// ── Component ──

interface OnboardingWizardProps {
  onComplete: () => void
}

export default function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const { currentStep, setStep } = useOnboardingStore()

  // LLM provider state; the Rust agent stores the key and reports hasApiKey
  const agentStatus = useAgentStore((s) => s.status)
  const [llm, setLlm] = useState<LlmState>({ provider: 'anthropic', apiKey: '', saving: false, error: null })

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

  // ── API key ──

  const keyStored = agentStatus?.provider === llm.provider && agentStatus.hasApiKey

  /** Makes the chosen provider active, then stores the typed key. Returns false on failure. */
  const saveKey = useCallback(async (): Promise<boolean> => {
    const apiKey = llm.apiKey.trim()
    if (!apiKey) return true
    setLlm((prev) => ({ ...prev, saving: true, error: null }))
    try {
      const agent = useAgentStore.getState()
      if (agent.status?.provider !== llm.provider) {
        await agent.setModel(llm.provider, PROVIDER_MODELS[llm.provider][0])
      }
      await agent.setApiKey(llm.provider, apiKey)
      setLlm((prev) => ({ ...prev, apiKey: '', saving: false }))
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setLlm((prev) => ({ ...prev, saving: false, error: message }))
      return false
    }
  }, [llm.apiKey, llm.provider])

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

  // ── Load the agent's current provider on LLM step mount ──

  useEffect(() => {
    if (currentStep !== 1) return
    let cancelled = false
    useAgentStore
      .getState()
      .refresh()
      .then((status) => {
        if (!cancelled) setLlm((prev) => ({ ...prev, provider: status.provider }))
      })
      .catch((err: unknown) => console.error('onboarding:agent-status failed', err))
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

  const providerConfigured = agentStatus?.hasApiKey === true

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
        <p className="onboarding-description">Choose a provider and paste its API key.</p>
      </div>

      <div className="onboarding-form">
        <div className="onboarding-choice" role="radiogroup" aria-label="AI provider">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={llm.provider === p}
              className={llm.provider === p ? 'selected' : undefined}
              onClick={() => setLlm((prev) => ({ ...prev, provider: p, error: null }))}
              data-testid={`provider-${p}`}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="onboarding-field">
          <label className="onboarding-label" htmlFor="ob-api-key">{PROVIDER_LABELS[llm.provider]} API key</label>
          <input
            id="ob-api-key"
            type="password"
            autoComplete="off"
            className="onboarding-input"
            placeholder="Paste your API key"
            value={llm.apiKey}
            onChange={(e) => setLlm((prev) => ({ ...prev, apiKey: e.target.value }))}
            data-testid="input-api-key"
          />
        </div>

        {keyStored && !llm.apiKey && (
          <div className="onboarding-connection-result success" data-testid="api-key-stored">Key stored</div>
        )}
        {llm.error && (
          <div className="onboarding-connection-result error" data-testid="api-key-error">{llm.error}</div>
        )}
      </div>

      <div className="onboarding-footer">
        <button
          className="onboarding-btn-primary"
          disabled={llm.saving}
          onClick={() => void saveKey().then((saved) => saved && nextStep())}
          data-testid="btn-llm-continue"
        >
          {llm.saving ? 'Saving…' : 'Continue'}
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
          {providerConfigured || printer.detected
            ? 'Your setup is complete. Start creating!'
            : 'You can configure providers and printer later from settings.'}
        </p>
      </div>

      <div className="onboarding-summary" data-testid="setup-summary">
        <div className="onboarding-summary-item">
          <div className={`summary-check ${providerConfigured ? 'done' : 'skipped'}`}>
            {providerConfigured ? '✓' : '—'}
          </div>
          <span>
            AI provider: {providerConfigured && agentStatus ? `${PROVIDER_LABELS[agentStatus.provider]}, key stored` : 'Not configured'}
          </span>
        </div>
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
