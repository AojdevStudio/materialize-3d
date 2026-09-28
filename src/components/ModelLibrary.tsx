import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLibraryStore, applyLibrarySnapshot, type LibraryModel } from '../stores/libraryStore'

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatImportDate(isoString: string): string {
  try {
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return isoString
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return isoString
  }
}

export function formatRating(rating: number | null): string {
  if (rating == null) return '—'
  return rating.toFixed(1)
}

export function formatDownloads(count: number | null): string {
  if (count == null) return '—'
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handleDelete(id: string) {
  try {
    await invoke('delete_library_model', { id })
    const models = await invoke<LibraryModel[]>('get_library_models')
    applyLibrarySnapshot(models)
  } catch (error) {
    console.error('failed to delete library model', error)
  }
}

async function handleOpenModel(id: string) {
  try {
    const snapshot = await invoke('open_library_model', { id })
    // open_library_model returns AppStateSnapshot — apply workspace portion
    const { applyWorkspaceSnapshot } = await import('../stores/workspace')
    applyWorkspaceSnapshot((snapshot as any).workspace)
  } catch (error) {
    console.error('failed to open library model', error)
  }
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ThumbnailImage({ url, modelName }: { url: string | null; modelName: string }) {
  const [failed, setFailed] = useState(false)

  if (!url || failed) {
    return (
      <div className="library-card-thumbnail library-card-thumbnail--placeholder" data-testid="library-thumbnail-placeholder">
        <span aria-hidden="true">📦</span>
      </div>
    )
  }

  return (
    <img
      className="library-card-thumbnail"
      src={url}
      alt={`${modelName} thumbnail`}
      data-testid="library-thumbnail"
      onError={() => setFailed(true)}
    />
  )
}

function ModelCard({ model }: { model: LibraryModel }) {
  return (
    <article className="library-card" data-testid="library-card">
      <ThumbnailImage url={model.thumbnailUrl} modelName={model.modelName} />

      <div className="library-card-body">
        <h3 className="library-card-title">{model.modelName}</h3>

        <div className="library-card-meta">
          {model.author && (
            <span className="library-card-author" data-testid="library-author">
              {model.author}
            </span>
          )}
          <span className="library-card-date" data-testid="library-date">
            {formatImportDate(model.importedAt)}
          </span>
        </div>

        <div className="library-card-stats">
          {model.rating != null && (
            <span className="library-card-rating" data-testid="library-rating" title="Rating">
              ⭐ {formatRating(model.rating)}
            </span>
          )}
          {model.downloadCount != null && (
            <span className="library-card-downloads" data-testid="library-downloads" title="Downloads">
              ⬇ {formatDownloads(model.downloadCount)}
            </span>
          )}
        </div>

        {model.sourceUrl && (
          <a
            className="library-card-source"
            href={model.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="library-source-link"
          >
            Source ↗
          </a>
        )}
      </div>

      <div className="library-card-actions">
        <button
          type="button"
          className="library-btn library-btn--reslice"
          onClick={() => void handleOpenModel(model.id)}
          aria-label={`Re-slice ${model.modelName}`}
          data-testid="library-reslice"
          title="Open in slicer"
        >
          🔄 Re-slice
        </button>
        <button
          type="button"
          className="library-btn library-btn--delete"
          onClick={() => void handleDelete(model.id)}
          aria-label={`Delete ${model.modelName}`}
          data-testid="library-delete"
          title="Delete from library"
        >
          🗑 Delete
        </button>
      </div>
    </article>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ModelLibrary() {
  const storeModels = useLibraryStore((s) => s.models)
  const [displayModels, setDisplayModels] = useState<LibraryModel[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load models on mount
  useEffect(() => {
    const load = async () => {
      try {
        const models = await invoke<LibraryModel[]>('get_library_models')
        applyLibrarySnapshot(models)
      } catch (error) {
        console.error('failed to load library models', error)
      }
    }
    void load()
  }, [])

  // Sync display models from store when search is empty
  useEffect(() => {
    if (!searchQuery.trim()) {
      setDisplayModels(storeModels)
    }
  }, [storeModels, searchQuery])

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query)

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }

    if (!query.trim()) {
      // Reset to full list from store
      setDisplayModels(useLibraryStore.getState().models)
      return
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const results = await invoke<LibraryModel[]>('search_library_models', { query: query.trim() })
        setDisplayModels(results)
      } catch (error) {
        console.error('failed to search library models', error)
      }
    }, 300)
  }, [])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  if (storeModels.length === 0 && !searchQuery.trim()) {
    return (
      <div className="model-library" data-testid="model-library">
        <div className="model-library-header">
          <h2 className="model-library-title">Model Library</h2>
        </div>
        <div className="model-library-empty" data-testid="model-library-empty">
          <span className="model-library-empty-icon" aria-hidden="true">📦</span>
          <h3 className="model-library-empty-heading">No models in library</h3>
          <p className="model-library-empty-subtext">
            Download models from MakerWorld to build your library
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="model-library" data-testid="model-library">
      <div className="model-library-header">
        <h2 className="model-library-title">Model Library</h2>
        <span className="model-library-count">
          {displayModels.length} model{displayModels.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="model-library-search">
        <input
          type="search"
          className="model-library-search-input"
          placeholder="Search models…"
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          data-testid="library-search-input"
          aria-label="Search models"
        />
      </div>

      {displayModels.length === 0 ? (
        <div className="model-library-no-results" data-testid="model-library-no-results">
          <p>No models match "{searchQuery}"</p>
        </div>
      ) : (
        <div className="model-library-grid">
          {displayModels.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      )}
    </div>
  )
}

export default ModelLibrary
