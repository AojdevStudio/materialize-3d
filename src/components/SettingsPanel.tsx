import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '../stores/settings'
import { PROVIDERS, PROVIDER_LABELS, modelLabel, useAgentStore } from '../stores/agent'
import type { Provider } from '../types/agent'
import { BambuStudioSection } from './BambuStudioSection'
import { McpSection } from './McpSection'

interface ProfileList {
  qualities: string[]
  filaments: string[]
}

export function SettingsPanel({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const settings = useSettingsStore((s) => s.settings)

  const [profiles, setProfiles] = useState<ProfileList | null>(null)

  // Fetch profiles when panel opens
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false

    const fetchProfiles = async () => {
      try {
        const result = await invoke<ProfileList>('list_profiles')
        if (!cancelled) {
          setProfiles(result)
        }
      } catch {
        if (!cancelled) setProfiles(null)
      }
    }

    void fetchProfiles()
    return () => { cancelled = true }
  }, [isOpen])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const timeout = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 0)
    return () => {
      clearTimeout(timeout)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [isOpen, onClose])

  const handleChange = useCallback(async (key: string, value: string) => {
    try {
      await invoke('update_settings', { settings: { [key]: value } })
    } catch (err) {
      console.error('settings:update failed', key, err)
    }
  }, [])

  const handleCheckbox = useCallback((key: string, checked: boolean) => {
    void handleChange(key, checked ? 'true' : 'false')
  }, [handleChange])

  if (!isOpen) return null

  // Use direct store access for current values — reads are reactive via Zustand selector
  const defaultQuality = settings['default.quality'] ?? ''
  const defaultFilament = settings['default.filament'] ?? ''
  const notifyComplete = settings['notifications.print_complete'] === 'true'
  const notifyFailed = settings['notifications.print_failed'] === 'true'
  const notifyFilament = settings['notifications.filament_low'] === 'true'
  const autoConnect = settings['connection.auto_connect'] === 'true'

  return (
    <div className="settings-panel" ref={panelRef} role="dialog" aria-label="Settings">
      <div className="settings-panel-header">
        <span className="settings-panel-title">Settings</span>
        <button
          type="button"
          className="settings-panel-close"
          onClick={onClose}
          aria-label="Close settings"
        >
          ✕
        </button>
      </div>

      <BambuStudioSection active={isOpen} />

      {/* Defaults Section */}
      <div className="settings-section">
        <div className="settings-section-label">Defaults</div>

        <label className="settings-field">
          <span>Quality</span>
          <select
            value={defaultQuality}
            onChange={(e) => handleChange('default.quality', e.target.value)}
            disabled={!profiles}
          >
            {profiles?.qualities.map((q) => (
              <option key={q} value={q}>{q}</option>
            )) ?? <option value={defaultQuality}>{defaultQuality}</option>}
          </select>
        </label>

        <label className="settings-field">
          <span>Filament</span>
          <select
            value={defaultFilament}
            onChange={(e) => handleChange('default.filament', e.target.value)}
            disabled={!profiles}
          >
            {profiles?.filaments.map((f) => (
              <option key={f} value={f}>{f}</option>
            )) ?? <option value={defaultFilament}>{defaultFilament}</option>}
          </select>
        </label>
      </div>

      <AgentSection active={isOpen} />

      {/* Notifications Section */}
      <div className="settings-section">
        <div className="settings-section-label">Notifications</div>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={notifyComplete}
            onChange={(e) => handleCheckbox('notifications.print_complete', e.target.checked)}
          />
          <span>Print complete</span>
        </label>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={notifyFailed}
            onChange={(e) => handleCheckbox('notifications.print_failed', e.target.checked)}
          />
          <span>Print failed</span>
        </label>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={notifyFilament}
            onChange={(e) => handleCheckbox('notifications.filament_low', e.target.checked)}
          />
          <span>Filament low</span>
        </label>
      </div>

      {/* Connection Section */}
      <div className="settings-section">
        <div className="settings-section-label">Connection</div>

        <label className="settings-checkbox">
          <input
            type="checkbox"
            checked={autoConnect}
            onChange={(e) => handleCheckbox('connection.auto_connect', e.target.checked)}
          />
          <span>Auto-connect on launch</span>
        </label>
      </div>

      <McpSection active={isOpen} />

    </div>
  )
}

/** Provider, model, and API key for the Rust agent. The key is write-only here. */
function AgentSection({ active }: { active: boolean }) {
  const status = useAgentStore((s) => s.status)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    useAgentStore
      .getState()
      .refresh()
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [active])

  const run = async (call: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await call()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <div className="settings-section">
        <div className="settings-section-label">Agent</div>
        {error && <div className="settings-slicer-warning" role="alert">{error}</div>}
      </div>
    )
  }

  const { provider, model, models, hasApiKey } = status
  const { setModel, setApiKey: storeKey, clearApiKey } = useAgentStore.getState()

  return (
    <div className="settings-section">
      <div className="settings-section-label">Agent</div>

      <label className="settings-field">
        <span>Provider</span>
        <select
          value={provider}
          disabled={busy}
          data-testid="agent-provider"
          onChange={(e) => {
            const next = e.target.value as Provider
            void run(() => setModel(next, ''))
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span>Model</span>
        <select
          value={model}
          disabled={busy}
          data-testid="agent-model"
          onChange={(e) => void run(() => setModel(provider, e.target.value))}
        >
          {models.map((m) => (
            <option key={m} value={m}>{modelLabel(m)}</option>
          ))}
        </select>
      </label>

      <form
        className="settings-field"
        onSubmit={(e) => {
          e.preventDefault()
          const key = apiKey.trim()
          if (!key) return
          void run(async () => {
            await storeKey(provider, key)
            setApiKey('')
          })
        }}
      >
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={hasApiKey ? 'Key stored' : `${PROVIDER_LABELS[provider]} API key`}
          onChange={(e) => setApiKey(e.target.value)}
          data-testid="agent-api-key"
        />
        <button type="submit" disabled={busy || !apiKey.trim()} data-testid="agent-api-key-save">
          Save
        </button>
        <button
          type="button"
          disabled={busy || !hasApiKey}
          onClick={() => void run(() => clearApiKey(provider))}
          data-testid="agent-api-key-clear"
        >
          Clear
        </button>
      </form>

      <div className="settings-hint" data-testid="agent-key-state">
        {hasApiKey ? 'Key stored' : 'No key stored'}
      </div>
      {error && <div className="settings-slicer-warning" role="alert">{error}</div>}
    </div>
  )
}

export default SettingsPanel
