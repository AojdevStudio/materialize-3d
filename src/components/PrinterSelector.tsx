import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { usePrinterConfigStore, type PrinterConfig } from '../stores/printerConfigs'
import { usePrinterStore } from '../stores/printer'

interface AddFormState {
  name: string
  host: string
  serial: string
  accessCode: string
}

const EMPTY_FORM: AddFormState = { name: '', host: '', serial: '', accessCode: '' }

export function PrinterSelector({ open, onClose }: { open: boolean; onClose: () => void }) {
  const configs = usePrinterConfigStore((s) => s.configs)
  const selectedPrinterId = usePrinterConfigStore((s) => s.selectedPrinterId)
  const connectionState = usePrinterStore((s) => s.connectionState)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [form, setForm] = useState<AddFormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay to avoid the opening click triggering immediate close
    const timeout = setTimeout(() => {
      document.addEventListener('mousedown', handleClick)
    }, 0)
    return () => {
      clearTimeout(timeout)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [open, onClose])

  const handleSwitch = useCallback(async (id: string) => {
    try {
      setError(null)
      await invoke('switch_printer', { configId: id })
      usePrinterConfigStore.getState().setSelectedPrinterId(id)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    try {
      setError(null)
      await invoke('delete_printer_config', { id })
      if (selectedPrinterId === id) {
        usePrinterConfigStore.getState().setSelectedPrinterId(null)
      }
    } catch (err) {
      setError(String(err))
    }
  }, [selectedPrinterId])

  const handleAdd = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.host.trim() || !form.serial.trim() || !form.accessCode.trim()) {
      setError('All fields are required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const config = await invoke<PrinterConfig>('add_printer_config', {
        name: form.name.trim(),
        host: form.host.trim(),
        serial: form.serial.trim(),
        accessCode: form.accessCode.trim(),
      })
      setForm(EMPTY_FORM)
      setShowAddForm(false)
      // Auto-select the newly added config
      usePrinterConfigStore.getState().setSelectedPrinterId(config.id)
    } catch (err) {
      setError(String(err))
    } finally {
      setSubmitting(false)
    }
  }, [form])

  const handleFormChange = useCallback((field: keyof AddFormState, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  if (!open) return null

  const activeConfig = configs.find((c) => c.id === selectedPrinterId)

  return (
    <div className="printer-selector-popover" ref={popoverRef} role="dialog" aria-label="Printer selector">
      <div className="printer-selector-header">
        <span className="printer-selector-title">Printers</span>
        <button
          type="button"
          className="printer-selector-close"
          onClick={onClose}
          aria-label="Close printer selector"
        >
          ✕
        </button>
      </div>

      {error && (
        <div className="printer-selector-error" role="alert">
          {error}
        </div>
      )}

      {configs.length === 0 && !showAddForm ? (
        <div className="printer-selector-empty">
          <p>No printers configured</p>
          <button
            type="button"
            className="printer-selector-add-btn"
            onClick={() => setShowAddForm(true)}
          >
            + Add your first printer
          </button>
        </div>
      ) : (
        <>
          <ul className="printer-selector-list">
            {configs.map((config) => {
              const isActive = config.id === selectedPrinterId
              const isConnected = isActive && (connectionState === 'connected_mqtt' || connectionState === 'connected_cloud')
              const isConnecting = isActive && (connectionState === 'discovering' || connectionState === 'reconnecting')

              return (
                <li key={config.id} className={`printer-selector-item ${isActive ? 'active' : ''}`}>
                  <button
                    type="button"
                    className="printer-selector-item-main"
                    onClick={() => handleSwitch(config.id)}
                    aria-label={`Switch to ${config.name}`}
                  >
                    <span
                      className={`printer-selector-dot ${
                        isConnected ? 'dot-green' : isConnecting ? 'dot-yellow pulsing' : 'dot-gray'
                      }`}
                      aria-hidden="true"
                    />
                    <span className="printer-selector-item-info">
                      <span className="printer-selector-item-name">
                        {config.name}
                        {config.isDefault && <span className="printer-selector-default-badge">default</span>}
                      </span>
                      <span className="printer-selector-item-host">{config.host}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="printer-selector-delete"
                    onClick={() => handleDelete(config.id)}
                    aria-label={`Delete ${config.name}`}
                  >
                    🗑
                  </button>
                </li>
              )
            })}
          </ul>

          {!showAddForm && (
            <button
              type="button"
              className="printer-selector-add-btn"
              onClick={() => setShowAddForm(true)}
            >
              + Add Printer
            </button>
          )}
        </>
      )}

      {showAddForm && (
        <form className="printer-selector-form" onSubmit={handleAdd}>
          <div className="printer-selector-form-title">Add Printer</div>
          <label className="printer-selector-field">
            <span>Name</span>
            <input
              type="text"
              value={form.name}
              onChange={(e) => handleFormChange('name', e.target.value)}
              placeholder="My Bambu P1S"
              autoFocus
            />
          </label>
          <label className="printer-selector-field">
            <span>Host / IP</span>
            <input
              type="text"
              value={form.host}
              onChange={(e) => handleFormChange('host', e.target.value)}
              placeholder="192.0.2.136"
            />
          </label>
          <label className="printer-selector-field">
            <span>Serial Number</span>
            <input
              type="text"
              value={form.serial}
              onChange={(e) => handleFormChange('serial', e.target.value)}
              placeholder="01P00A000000000"
            />
          </label>
          <label className="printer-selector-field">
            <span>Access Code</span>
            <input
              type="password"
              value={form.accessCode}
              onChange={(e) => handleFormChange('accessCode', e.target.value)}
              placeholder="••••••••"
            />
          </label>
          <div className="printer-selector-form-actions">
            <button
              type="button"
              className="printer-selector-cancel"
              onClick={() => { setShowAddForm(false); setForm(EMPTY_FORM); setError(null) }}
            >
              Cancel
            </button>
            <button type="submit" className="printer-selector-submit" disabled={submitting}>
              {submitting ? 'Adding…' : 'Add Printer'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

export default PrinterSelector
