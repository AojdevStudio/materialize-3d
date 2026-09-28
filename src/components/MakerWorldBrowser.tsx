import { invoke } from '@tauri-apps/api/core'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  MAKERWORLD_HOME_URL,
  useWorkspaceStore,
  type MakerWorldModel,
  type ModelImportStatus,
} from '../stores/workspace'

interface MakerWorldBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

function buildBounds(element: HTMLElement, visible: boolean): MakerWorldBounds {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height, 1),
    visible,
  }
}

function formatCount(value: number | null) {
  if (value == null) return '—'
  return Intl.NumberFormat().format(value)
}

function formatRating(model: MakerWorldModel | null) {
  if (model?.rating == null) return '—'
  return model.rating.toFixed(1)
}

function importLabel(status: ModelImportStatus) {
  if (status === 'downloading') return 'Importing…'
  if (status === 'imported') return 'Imported'
  if (status === 'error') return 'Retry Import'
  return 'Import to Library'
}

function isUrlLike(value: string) {
  return /^https?:\/\//i.test(value) || /^makerworld\.com/i.test(value) || /^www\.makerworld\.com/i.test(value)
}

export function MakerWorldBrowser() {
  const makerworld = useWorkspaceStore((state) => state.makerworld)
  const navigateMakerWorld = useWorkspaceStore((state) => state.navigateMakerWorld)
  const searchMakerWorld = useWorkspaceStore((state) => state.searchMakerWorld)
  const goBackMakerWorld = useWorkspaceStore((state) => state.goBackMakerWorld)
  const goForwardMakerWorld = useWorkspaceStore((state) => state.goForwardMakerWorld)
  const reloadMakerWorld = useWorkspaceStore((state) => state.reloadMakerWorld)
  const importMakerWorldModel = useWorkspaceStore((state) => state.importMakerWorldModel)

  const [address, setAddress] = useState(makerworld.currentUrl)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    setAddress(makerworld.currentUrl)
  }, [makerworld.currentUrl])

  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return

    const sync = async (visible: boolean) => {
      if (!slotRef.current) return
      await invoke('sync_makerworld_webview', { bounds: buildBounds(slotRef.current, visible) })
    }

    const schedule = (visible: boolean) => {
      if (typeof window === 'undefined') return
      const requestFrame = window.requestAnimationFrame?.bind(window) ?? ((callback: FrameRequestCallback) => window.setTimeout(callback, 0))
      const cancelFrame = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window)
      if (frameRef.current != null) {
        cancelFrame(frameRef.current)
      }
      frameRef.current = requestFrame(() => {
        void sync(visible)
      }) as unknown as number
    }

    schedule(true)

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => schedule(true))
      : null
    resizeObserver?.observe(slot)

    const onResize = () => schedule(true)
    window.addEventListener('resize', onResize)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', onResize)
      if (typeof window !== 'undefined' && frameRef.current != null) {
        const cancelFrame = window.cancelAnimationFrame?.bind(window) ?? window.clearTimeout.bind(window)
        cancelFrame(frameRef.current)
      }
      void sync(false)
    }
  }, [])

  const metadataRows = useMemo(
    () => [
      { label: 'Author', value: makerworld.detectedModel?.author ?? '—' },
      { label: 'Rating', value: formatRating(makerworld.detectedModel) },
      { label: 'Reviews', value: formatCount(makerworld.detectedModel?.reviewCount ?? null) },
      { label: 'Downloads', value: formatCount(makerworld.detectedModel?.downloadCount ?? null) },
    ],
    [makerworld.detectedModel],
  )

  const canImport = makerworld.pageKind === 'model' && makerworld.detectedModel !== null && makerworld.importStatus !== 'downloading'

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = address.trim()
    if (!value) {
      await navigateMakerWorld(MAKERWORLD_HOME_URL)
      return
    }

    if (isUrlLike(value)) {
      await navigateMakerWorld(value)
    } else {
      await searchMakerWorld(value)
    }
  }

  return (
    <div className="makerworld-browser-shell">
      <form className="makerworld-browser-toolbar" onSubmit={(event) => void handleSubmit(event)}>
        <div className="makerworld-nav-group">
          <button type="button" className="makerworld-nav-btn" aria-label="Go back" onClick={() => void goBackMakerWorld()}>
            ←
          </button>
          <button type="button" className="makerworld-nav-btn" aria-label="Go forward" onClick={() => void goForwardMakerWorld()}>
            →
          </button>
          <button type="button" className="makerworld-nav-btn" aria-label="Reload page" onClick={() => void reloadMakerWorld()}>
            ↻
          </button>
        </div>

        <input
          className="makerworld-address"
          type="text"
          aria-label="MakerWorld address"
          placeholder="Search MakerWorld or paste URL"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />

        <button type="submit" className="makerworld-action-btn makerworld-open-btn">
          Open
        </button>
        <button
          type="button"
          className="makerworld-action-btn makerworld-import-btn"
          disabled={!canImport}
          onClick={() => void importMakerWorldModel()}
        >
          {importLabel(makerworld.importStatus)}
        </button>
      </form>

      <div className="makerworld-browser-body">
        <aside className="makerworld-inspector">
          <div className="makerworld-chip-row">
            <span className="makerworld-chip">{makerworld.pageKind}</span>
            <span className={`makerworld-chip status-${makerworld.importStatus}`}>{makerworld.importStatus}</span>
          </div>

          <h2 className="makerworld-model-title">
            {makerworld.detectedModel?.title ?? 'Browse MakerWorld to detect a model page'}
          </h2>

          <p className="makerworld-model-copy">
            {makerworld.detectedModel
              ? 'Metadata is extracted from the live MakerWorld page and mirrored through the Rust workspace store.'
              : 'Open a MakerWorld model page to extract title, author, files, ratings, and to enable local import.'}
          </p>

          <div className="makerworld-meta-grid">
            {metadataRows.map((row) => (
              <div className="makerworld-meta-card" key={row.label}>
                <div className="makerworld-meta-label">{row.label}</div>
                <div className="makerworld-meta-value">{row.value}</div>
              </div>
            ))}
          </div>

          <section className="makerworld-file-list" aria-label="Detected files">
            <div className="makerworld-section-title">Files</div>
            {makerworld.detectedModel?.files.length ? (
              makerworld.detectedModel.files.map((file) => (
                <div className="makerworld-file-row" key={`${file.name}-${file.fileType ?? 'unknown'}`}>
                  <span>{file.name}</span>
                  <span>{file.fileType ?? 'file'}</span>
                </div>
              ))
            ) : (
              <div className="makerworld-empty">No files detected yet.</div>
            )}
          </section>

          <section className="makerworld-file-list" aria-label="Imported files">
            <div className="makerworld-section-title">Imported Files</div>
            {makerworld.importedFiles.length ? (
              makerworld.importedFiles.map((file) => (
                <div className="makerworld-file-row" key={file}>
                  <span className="makerworld-path">{file}</span>
                </div>
              ))
            ) : (
              <div className="makerworld-empty">No imports yet.</div>
            )}
          </section>

          {makerworld.lastExtractionError ? (
            <div className="makerworld-error" role="alert">
              {makerworld.lastExtractionError}
            </div>
          ) : null}
        </aside>

        <div className="makerworld-webview-wrap">
          <div className="makerworld-webview-slot" ref={slotRef} aria-label="MakerWorld embedded browser">
            <div className="makerworld-webview-fallback">
              <div className="placeholder-kicker">Embedded Webview</div>
              <h3 className="makerworld-fallback-title">MakerWorld</h3>
              <p className="placeholder-copy">
                In the native Tauri runtime this slot is replaced by a child WKWebView. Browser dev mode keeps this
                placeholder while the mock IPC surface drives state updates.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default MakerWorldBrowser
