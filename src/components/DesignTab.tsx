/**
 * DesignTab — composition root for the OpenSCAD design workflow.
 *
 * Layout: flex row
 *   Left (~60%): toolbar + Monaco editor
 *   Right (~40%): top = ParameterPanel, bottom = ModelViewer preview
 *
 * Features:
 * - File open via Tauri dialog (filtered to .scad)
 * - Live preview: parameter changes and code saves trigger re-render
 * - Render status indicator (idle/rendering/error)
 * - Empty state prompts user to open a file
 */
import { useCallback, useEffect, useRef } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useOpenScadStore } from '../stores/openscadStore'
import OpenScadEditor from './OpenScadEditor'
import ParameterPanel from './ParameterPanel'
import { ModelViewer } from './ModelViewer'
import styles from './DesignTab.module.css'

/** Extract filename from absolute path */
function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

/** Status badge color class */
function statusClass(status: string): string {
  switch (status) {
    case 'rendering':
    case 'extracting_params':
      return styles.statusBusy
    case 'error':
      return styles.statusError
    case 'idle':
      return styles.statusIdle
    default:
      return styles.statusIdle
  }
}

/** Human-readable status label */
function statusLabel(status: string): string {
  switch (status) {
    case 'rendering':
      return 'Rendering…'
    case 'extracting_params':
      return 'Extracting…'
    case 'error':
      return 'Error'
    case 'idle':
      return 'Ready'
    default:
      return status
  }
}

export default function DesignTab() {
  const loadedFile = useOpenScadStore((s) => s.loadedFile)
  const renderStatus = useOpenScadStore((s) => s.renderStatus)
  const lastStlPath = useOpenScadStore((s) => s.lastStlPath)
  const lastError = useOpenScadStore((s) => s.lastError)
  const loadFile = useOpenScadStore((s) => s.loadFile)
  const render = useOpenScadStore((s) => s.render)

  // Track if initial render was triggered after file load
  const didInitialRender = useRef(false)

  // After loadFile completes (params extracted), trigger first render
  useEffect(() => {
    if (loadedFile && renderStatus === 'idle' && !didInitialRender.current) {
      didInitialRender.current = true
      const state = useOpenScadStore.getState()
      const overrides: Record<string, string> = {}
      for (const p of state.parameters) {
        overrides[p.name] = String(p.initial)
      }
      console.debug('openscad:initial-render', loadedFile)
      void render(overrides)
    }
  }, [loadedFile, renderStatus, render])

  // Reset initial render flag when file changes
  useEffect(() => {
    didInitialRender.current = false
  }, [loadedFile])

  const handleOpenFile = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'OpenSCAD', extensions: ['scad'] }],
    })
    if (selected) {
      console.debug('openscad:file-open', selected)
      void loadFile(selected as string)
    }
  }, [loadFile])

  const handleSave = useCallback(
    async (code: string) => {
      if (!loadedFile) return
      await invoke('write_text_file', { path: loadedFile, content: code })
      // Re-render after save
      const state = useOpenScadStore.getState()
      const overrides: Record<string, string> = {}
      for (const p of state.parameters) {
        overrides[p.name] = String(p.initial)
      }
      console.debug('openscad:save-and-render', loadedFile)
      void render(overrides)
    },
    [loadedFile, render],
  )

  // Empty state: no file loaded
  if (!loadedFile) {
    return (
      <div className={styles.container} data-testid="design-tab">
        <div className={styles.emptyState} data-testid="design-tab-empty">
          <div className={styles.emptyIcon}>⎔</div>
          <h3 className={styles.emptyTitle}>No file open</h3>
          <p className={styles.emptyCopy}>
            Open an OpenSCAD file to start designing with parametric controls and live preview.
          </p>
          <button
            type="button"
            className={styles.openButton}
            onClick={handleOpenFile}
            data-testid="open-file-button"
          >
            Open .scad File
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container} data-testid="design-tab">
      {/* ─── Toolbar ──────────────────────────────────────────────────── */}
      <div className={styles.toolbar} data-testid="design-toolbar">
        <button
          type="button"
          className={styles.toolbarButton}
          onClick={handleOpenFile}
          data-testid="open-file-button"
        >
          Open File
        </button>
        <span className={styles.fileName} title={loadedFile}>
          {basename(loadedFile)}
        </span>
        <div className={styles.spacer} />
        <div className={`${styles.statusBadge} ${statusClass(renderStatus)}`} data-testid="render-status">
          <span className={styles.statusDot} />
          {statusLabel(renderStatus)}
        </div>
        {lastError && (
          <span className={styles.errorSummary} title={lastError.message}>
            Line {lastError.line}: {lastError.message}
          </span>
        )}
      </div>

      {/* ─── Main Layout ──────────────────────────────────────────────── */}
      <div className={styles.layout}>
        {/* Left: Editor */}
        <div className={styles.editorPane} data-testid="editor-pane">
          <OpenScadEditor
            filePath={loadedFile}
            onSave={handleSave}
          />
        </div>

        {/* Right: Params + Preview */}
        <div className={styles.rightPane}>
          <div className={styles.paramPane} data-testid="param-pane">
            <ParameterPanel />
          </div>
          <div className={styles.previewPane} data-testid="preview-pane">
            <ModelViewer modelPath={lastStlPath} />
          </div>
        </div>
      </div>
    </div>
  )
}
