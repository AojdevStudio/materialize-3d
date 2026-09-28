import { useCallback, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { usePrinterStore, type ConnectionState } from '../stores/printer'
import { usePrinterConfigStore } from '../stores/printerConfigs'
import { PrinterSelector } from './PrinterSelector'
import { SettingsPanel } from './SettingsPanel'
import { useUiStore } from '../stores/ui'

/** States where a connection attempt is already in progress */
const BUSY_STATES: readonly ConnectionState[] = ['discovering', 'reconnecting'] as const

const CONNECTION_DISPLAY: Record<ConnectionState, { dotClass: string; label: string }> = {
  disconnected:    { dotClass: 'dot-gray',           label: 'Offline' },
  discovering:     { dotClass: 'dot-yellow pulsing',  label: 'Connecting…' },
  connected_mqtt:  { dotClass: 'dot-green',           label: 'MQTT' },
  connected_cloud: { dotClass: 'dot-green',           label: 'CLOUD' },
  reconnecting:    { dotClass: 'dot-orange pulsing',  label: 'Reconnecting' },
  offline:         { dotClass: 'dot-red',             label: 'Offline' },
}

export function Toolbar() {
  const connectionState = usePrinterStore((s) => s.connectionState)
  const printerStoreName = usePrinterStore((s) => s.name)
  const lastError = usePrinterStore((s) => s.lastError)
  const configs = usePrinterConfigStore((s) => s.configs) ?? []
  const selectedPrinterId = usePrinterConfigStore((s) => s.selectedPrinterId) ?? null
  const [selectorOpen, setSelectorOpen] = useState(false)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)

  // Resolve display name: active config name → printer store name → fallback
  const activeConfig = configs.find((c) => c.id === selectedPrinterId)
  const printerName = activeConfig?.name ?? printerStoreName ?? 'No Printer'

  const display = CONNECTION_DISPLAY[connectionState] ?? CONNECTION_DISPLAY.disconnected

  const toggleSelector = useCallback(() => {
    setSelectorOpen((prev) => !prev)
    setSettingsOpen(false)
  }, [setSettingsOpen])

  const closeSelector = useCallback(() => {
    setSelectorOpen(false)
  }, [])

  const toggleSettings = useCallback(() => {
    setSettingsOpen(!useUiStore.getState().settingsOpen)
    setSelectorOpen(false)
  }, [setSettingsOpen])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [setSettingsOpen])

  // Error recovery: show when connection is failed AND there's an error message
  const showError =
    (connectionState === 'offline' || connectionState === 'disconnected') && !!lastError
  const retryBusy = (BUSY_STATES as readonly string[]).includes(connectionState)
  const showDisconnect = connectionState === 'reconnecting'

  const handleRetry = useCallback(async () => {
    try {
      if (selectedPrinterId) {
        await invoke('connect_printer_by_config', { configId: selectedPrinterId })
      } else {
        await invoke('connect_printer', { credentialsPath: null })
      }
    } catch (err) {
      console.error('connection:retry failed', err)
    }
  }, [selectedPrinterId])

  const handleDisconnect = useCallback(async () => {
    try {
      await invoke('disconnect_printer')
    } catch (err) {
      console.error('connection:disconnect failed', err)
    }
  }, [])

  // Truncate error message for display
  const errorDisplay = lastError && lastError.length > 80
    ? lastError.slice(0, 80) + '…'
    : lastError

  return (
    <header className="toolbar">
      <div className="toolbar-logo">Materialize</div>
      <div className="toolbar-divider" aria-hidden="true" />

      <div className="printer-badge-wrapper">
        <button
          type="button"
          className="printer-badge"
          role="status"
          aria-label="printer connection status"
          aria-expanded={selectorOpen}
          title={lastError ?? undefined}
          onClick={toggleSelector}
        >
          <span
            className={`printer-dot ${display.dotClass}`}
            aria-hidden="true"
          />
          <span>{printerName}</span>
          <span className="printer-connection-type">{display.label}</span>
          <span className="printer-badge-chevron" aria-hidden="true">▾</span>
        </button>

        <PrinterSelector open={selectorOpen} onClose={closeSelector} />
      </div>

      {showError && (
        <div className="connection-error" role="alert" aria-label="Connection error">
          <span className="connection-error-msg">{errorDisplay}</span>
          <button
            type="button"
            className="connection-error-btn connection-error-retry"
            onClick={handleRetry}
            disabled={retryBusy}
            aria-label="Retry connection"
          >
            Retry
          </button>
        </div>
      )}

      {showDisconnect && (
        <div className="connection-error" role="alert" aria-label="Connection error">
          <span className="connection-error-msg">Reconnecting…</span>
          <button
            type="button"
            className="connection-error-btn connection-error-disconnect"
            onClick={handleDisconnect}
            aria-label="Disconnect"
          >
            Disconnect
          </button>
        </div>
      )}

      <div className="toolbar-spacer" />

      <div className="toolbar-actions">
        <button className="toolbar-btn" type="button" aria-label="Notifications">
          🔔
        </button>
        <div className="settings-btn-wrapper">
          <button
            className="toolbar-btn"
            type="button"
            aria-label="Settings"
            ref={settingsButtonRef}
            aria-expanded={settingsOpen}
            onClick={toggleSettings}
          >
            ⚙
          </button>
          <SettingsPanel isOpen={settingsOpen} onClose={closeSettings} />
        </div>
      </div>
    </header>
  )
}

export default Toolbar
