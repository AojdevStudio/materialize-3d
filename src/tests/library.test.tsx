// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listenMock = vi.fn()
const invokeMock = vi.fn()

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import type { LibraryModel } from '../stores/libraryStore'

const SAMPLE_MODELS: LibraryModel[] = [
  {
    id: 'lib-1',
    modelName: 'Headphone Hook',
    author: 'DesignMaster',
    sourceUrl: 'https://makerworld.com/model/123',
    importedAt: '2026-03-15T08:00:00Z',
    thumbnailUrl: 'https://cdn.example.com/thumb1.jpg',
    filePath: '/tmp/models/hook/hook.3mf',
    folderPath: '/tmp/models/hook',
    rating: 4.7,
    downloadCount: 12500,
    fileCount: 3,
  },
  {
    id: 'lib-2',
    modelName: 'Cable Organizer',
    author: 'PrintPro',
    sourceUrl: null,
    importedAt: '2026-03-14T14:00:00Z',
    thumbnailUrl: null,
    filePath: null,
    folderPath: '/tmp/models/cable',
    rating: null,
    downloadCount: null,
    fileCount: 1,
  },
  {
    id: 'lib-3',
    modelName: 'Phone Stand',
    author: null,
    sourceUrl: 'https://makerworld.com/model/456',
    importedAt: '2026-03-13T10:00:00Z',
    thumbnailUrl: 'https://cdn.example.com/thumb3.jpg',
    filePath: '/tmp/models/stand/stand.3mf',
    folderPath: '/tmp/models/stand',
    rating: 3.2,
    downloadCount: 800,
    fileCount: 2,
  },
]

describe('ModelLibrary component', () => {
  beforeEach(async () => {
    listenMock.mockImplementation(async () => () => {})
    invokeMock.mockResolvedValue([])

    const { useLibraryStore, LIBRARY_DEFAULT_STATE } = await import('../stores/libraryStore')
    useLibraryStore.setState(LIBRARY_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders empty state with "No models in library"', async () => {
    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    expect(screen.getByTestId('model-library-empty')).toBeDefined()
    expect(screen.getByText('No models in library')).toBeDefined()
    expect(screen.getByText('Download models from MakerWorld to build your library')).toBeDefined()
  })

  it('renders grid with model cards when populated', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    act(() => {
      useLibraryStore.getState().applySnapshot(SAMPLE_MODELS)
    })

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    const cards = screen.getAllByTestId('library-card')
    expect(cards).toHaveLength(3)

    expect(screen.getByText('Headphone Hook')).toBeDefined()
    expect(screen.getByText('Cable Organizer')).toBeDefined()
    expect(screen.getByText('Phone Stand')).toBeDefined()
  })

  it('has search input when models exist', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    act(() => {
      useLibraryStore.getState().applySnapshot(SAMPLE_MODELS)
    })

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    const input = screen.getByTestId('library-search-input')
    expect(input).toBeDefined()
    expect(input.getAttribute('placeholder')).toBe('Search models…')
  })

  it('delete button calls invoke with model id', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    act(() => {
      useLibraryStore.getState().applySnapshot([SAMPLE_MODELS[0]])
    })

    invokeMock.mockResolvedValue([])

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    const deleteBtn = screen.getByTestId('library-delete')
    expect(deleteBtn).toBeDefined()
    expect(deleteBtn.getAttribute('aria-label')).toBe('Delete Headphone Hook')

    await act(async () => {
      deleteBtn.click()
    })

    expect(invokeMock).toHaveBeenCalledWith('delete_library_model', { id: 'lib-1' })
  })

  it('re-slice button calls invoke with model id', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    act(() => {
      useLibraryStore.getState().applySnapshot([SAMPLE_MODELS[0]])
    })

    const workspaceSnapshot = { workspace: { activeModel: null, activeView: 'preview', makerworld: { currentUrl: '', pageKind: 'home', detectedModel: null, importStatus: 'idle', importedFiles: [], lastExtractionError: null } } }
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'open_library_model') return workspaceSnapshot
      if (cmd === 'get_library_models') return [SAMPLE_MODELS[0]]
      return []
    })

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    const resliceBtn = screen.getByTestId('library-reslice')
    expect(resliceBtn).toBeDefined()
    expect(resliceBtn.getAttribute('aria-label')).toBe('Re-slice Headphone Hook')

    await act(async () => {
      resliceBtn.click()
    })

    expect(invokeMock).toHaveBeenCalledWith('open_library_model', { id: 'lib-1' })
  })

  it('shows placeholder thumbnail when no URL', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    // Cable Organizer has thumbnailUrl: null
    act(() => {
      useLibraryStore.getState().applySnapshot([SAMPLE_MODELS[1]])
    })

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    expect(screen.getByTestId('library-thumbnail-placeholder')).toBeDefined()
  })

  it('displays author and date metadata', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    act(() => {
      useLibraryStore.getState().applySnapshot([SAMPLE_MODELS[0]])
    })

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    expect(screen.getByTestId('library-author').textContent).toBe('DesignMaster')
    expect(screen.getByTestId('library-date')).toBeDefined()
  })

  it('displays rating and download count', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    act(() => {
      useLibraryStore.getState().applySnapshot([SAMPLE_MODELS[0]])
    })

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    expect(screen.getByTestId('library-rating').textContent).toContain('4.7')
    expect(screen.getByTestId('library-downloads').textContent).toContain('12.5K')
  })

  it('shows source link when sourceUrl is present', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')

    act(() => {
      useLibraryStore.getState().applySnapshot([SAMPLE_MODELS[0]])
    })

    const { ModelLibrary } = await import('../components/ModelLibrary')
    render(React.createElement(ModelLibrary))

    const link = screen.getByTestId('library-source-link')
    expect(link.getAttribute('href')).toBe('https://makerworld.com/model/123')
  })

  it('loads models on mount via invoke', async () => {
    invokeMock.mockResolvedValue(SAMPLE_MODELS)

    const { ModelLibrary } = await import('../components/ModelLibrary')
    await act(async () => {
      render(React.createElement(ModelLibrary))
    })

    expect(invokeMock).toHaveBeenCalledWith('get_library_models')
  })
})

describe('ModelLibrary helpers', () => {
  it('formatImportDate formats ISO date', async () => {
    const { formatImportDate } = await import('../components/ModelLibrary')
    const result = formatImportDate('2026-03-15T08:00:00Z')
    expect(result).not.toBe('2026-03-15T08:00:00Z')
    expect(result.length).toBeGreaterThan(5)
    expect(formatImportDate('not-a-date')).toBe('not-a-date')
  })

  it('formatRating handles null and values', async () => {
    const { formatRating } = await import('../components/ModelLibrary')
    expect(formatRating(null)).toBe('—')
    expect(formatRating(4.7)).toBe('4.7')
    expect(formatRating(3.0)).toBe('3.0')
  })

  it('formatDownloads abbreviates large numbers', async () => {
    const { formatDownloads } = await import('../components/ModelLibrary')
    expect(formatDownloads(null)).toBe('—')
    expect(formatDownloads(500)).toBe('500')
    expect(formatDownloads(12500)).toBe('12.5K')
    expect(formatDownloads(1500000)).toBe('1.5M')
  })
})
