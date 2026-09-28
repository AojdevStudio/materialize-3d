// @vitest-environment jsdom
import React from 'react'
import { JSDOM } from 'jsdom'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

if (typeof document === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
  })
}

describe('MakerWorld browser workspace', () => {
  beforeEach(async () => {
    const { useWorkspaceStore } = await import('../stores/workspace')
    useWorkspaceStore.setState({
      activeModel: null,
      activeView: 'browser',
      makerworld: {
        currentUrl: 'https://makerworld.com/en',
        pageKind: 'home',
        importStatus: 'idle',
        detectedModel: null,
        importedFiles: [],
        lastExtractionError: null,
      },
    })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('tracks makerworld browser state in the workspace store', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace')

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeView: 'browser',
      makerworld: {
        currentUrl: 'https://makerworld.com/en',
        pageKind: 'home',
        importStatus: 'idle',
        detectedModel: null,
        importedFiles: [],
      },
    })
  })

  it('renders MakerWorld controls and enables import when a model is detected', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace')
    const { MainPanel } = await import('../components/MainPanel')

    act(() => {
      useWorkspaceStore.setState({
        activeModel: null,
        activeView: 'browser',
        makerworld: {
          currentUrl: 'https://makerworld.com/en',
          pageKind: 'home',
          importStatus: 'idle',
          detectedModel: null,
          importedFiles: [],
          lastExtractionError: null,
        },
      })
    })

    const view = render(React.createElement(MainPanel))
    expect(view.container.innerHTML).toContain('Search MakerWorld or paste URL')
    expect(view.container.innerHTML).toContain('Import to Library')
    expect(view.container.innerHTML).toContain('disabled=""')

    act(() => {
      useWorkspaceStore.getState().applySnapshot({
        activeModel: null,
        activeView: 'browser',
        makerworld: {
          currentUrl: 'https://makerworld.com/en/models/1073764-simple-headphone-hook-dual-color?from=search',
          pageKind: 'model',
          importStatus: 'ready',
          lastExtractionError: null,
          importedFiles: [],
          detectedModel: {
            id: '1073764',
            title: 'Simple Headphone Hook',
            author: 'AOJDevStudio',
            sourceUrl: 'https://makerworld.com/en/models/1073764-simple-headphone-hook-dual-color?from=search',
            rating: 4.8,
            reviewCount: 12,
            downloadCount: 341,
            images: ['https://makerworld.com/image.jpg'],
            files: [{ name: 'headphone-hook.3mf', fileType: '3MF', downloadUrl: null }],
          },
        },
      })
    })

    expect(view.container.innerHTML).toContain('Simple Headphone Hook')
    expect(view.container.innerHTML).toContain('AOJDevStudio')
    expect(view.container.innerHTML).toContain('4.8')
    expect(view.container.innerHTML).not.toContain('disabled=""')
  })
})
