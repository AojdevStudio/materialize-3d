// @vitest-environment jsdom
import React from 'react'
import { JSDOM } from 'jsdom'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

if (typeof document === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
  })
}

type EventHandler<T = unknown> = (event: { payload: T }) => void

const listenMock = vi.fn()
const invokeMock = vi.fn()
const unlistenMock = vi.fn()
const eventHandlers = new Map<string, EventHandler>()

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

function emitEvent<T>(name: string, payload: T) {
  const handler = eventHandlers.get(name)
  if (!handler) {
    throw new Error(`No handler registered for ${name}`)
  }

  act(() => {
    handler({ payload })
  })
}

describe('zustand tauri bridge stores', () => {
  beforeEach(async () => {
    eventHandlers.clear()
    listenMock.mockReset()
    invokeMock.mockReset()
    unlistenMock.mockReset()

    listenMock.mockImplementation(async (name: string, handler: EventHandler) => {
      eventHandlers.set(name, handler)
      return () => {
        unlistenMock(name)
        eventHandlers.delete(name)
      }
    })

    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useWorkspaceStore, WORKSPACE_DEFAULT_STATE } = await import('../stores/workspace')
    const { useUiStore, UI_DEFAULT_STATE } = await import('../stores/ui')

    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useWorkspaceStore.setState(WORKSPACE_DEFAULT_STATE)
    useUiStore.setState(UI_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('subscribes and unsubscribes tauri listeners through useTauriEvent', async () => {
    const { useTauriEvent } = await import('../hooks/useTauriEvent')

    function TestComponent() {
      useTauriEvent('workspace:changed', vi.fn())
      return null
    }

    const view = render(React.createElement(TestComponent))
    expect(listenMock).toHaveBeenCalledWith('workspace:changed', expect.any(Function))

    view.unmount()
    await act(async () => {
      await Promise.resolve()
    })

    expect(unlistenMock).toHaveBeenCalledWith('workspace:changed')
  })

  it('initializes stores with the expected defaults', async () => {
    const { usePrinterStore } = await import('../stores/printer')
    const { useWorkspaceStore } = await import('../stores/workspace')
    const { useUiStore } = await import('../stores/ui')

    expect(usePrinterStore.getState()).toMatchObject({
      isConnected: false,
      connectionType: null,
      connectionState: 'disconnected',
      name: null,
      nozzleTemp: null,
      nozzleTargetTemp: null,
      bedTemp: null,
      bedTargetTemp: null,
      chamberTemp: null,
      gcodeState: null,
      printProgress: null,
      remainingTime: null,
      layerNum: null,
      totalLayerNum: null,
      subtaskName: null,
      wifiSignal: null,
      amsState: [],
      lastError: null,
    })

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeModel: null,
      activeView: 'preview',
      makerworld: {
        currentUrl: 'https://makerworld.com/en',
        pageKind: 'home',
        importStatus: 'idle',
        detectedModel: null,
        importedFiles: [],
      },
    })

    expect(useUiStore.getState()).toMatchObject({
      sidebarItem: 'library',
      chatOpen: true,
    })
  })

  it('routes setActiveView through the tauri command and waits for the backend event to update store state', async () => {
    const { useWorkspaceStore, useWorkspaceEvents } = await import('../stores/workspace')

    function WorkspaceBridge() {
      useWorkspaceEvents()
      return null
    }

    render(React.createElement(WorkspaceBridge))
    invokeMock.mockResolvedValue({})

    await useWorkspaceStore.getState().setActiveView('browser')

    expect(invokeMock).toHaveBeenCalledWith('set_active_view', { view: 'browser' })
    expect(useWorkspaceStore.getState().activeView).toBe('preview')

    emitEvent('workspace:changed', {
      activeModel: null,
      activeView: 'browser',
      makerworld: {
        currentUrl: 'https://makerworld.com/en/search/models?keyword=hook',
        pageKind: 'search',
        importStatus: 'idle',
        detectedModel: null,
        importedFiles: [],
        lastExtractionError: null,
      },
    })

    expect(useWorkspaceStore.getState().activeView).toBe('browser')
  })

  it('maps workspace and printer change payloads into store state', async () => {
    const { usePrinterStore, usePrinterEvents } = await import('../stores/printer')
    const { useWorkspaceStore, useWorkspaceEvents } = await import('../stores/workspace')
    const { useUiStore } = await import('../stores/ui')

    function EventBridge() {
      usePrinterEvents()
      useWorkspaceEvents()
      return null
    }

    render(React.createElement(EventBridge))

    emitEvent('printer:changed', {
      isConnected: true,
      connectionType: 'mqtt',
      name: 'AOJDevStudio',
      nozzleTemp: 219.4,
      bedTemp: 58.2,
    })

    emitEvent('workspace:changed', {
      activeModel: {
        id: 'model-1',
        name: 'Headphone Wall Hook',
        path: '/tmp/hook.stl',
        source: 'makerworld',
        sizeBytes: 2400000,
      },
      activeView: 'scad',
      makerworld: {
        currentUrl: 'https://makerworld.com/en/models/1073764-simple-headphone-hook',
        pageKind: 'model',
        importStatus: 'imported',
        lastExtractionError: null,
        importedFiles: ['/tmp/hook.stl'],
        detectedModel: {
          id: '1073764',
          title: 'Headphone Wall Hook',
          author: 'AOJDevStudio',
          sourceUrl: 'https://makerworld.com/en/models/1073764-simple-headphone-hook',
          rating: 4.9,
          reviewCount: 18,
          downloadCount: 456,
          images: ['https://makerworld.com/cover.jpg'],
          files: [{ name: 'hook.3mf', fileType: '3MF', downloadUrl: null }],
        },
      },
    })

    expect(usePrinterStore.getState()).toMatchObject({
      isConnected: true,
      connectionType: 'mqtt',
      name: 'AOJDevStudio',
      nozzleTemp: 219.4,
      bedTemp: 58.2,
    })

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeModel: {
        id: 'model-1',
        name: 'Headphone Wall Hook',
      },
      activeView: 'scad',
    })

    expect(useUiStore.getState().sidebarItem).toBe('design')
  })

  it('updates frontend-only ui store actions without rust backing', async () => {
    const { useUiStore } = await import('../stores/ui')

    act(() => {
      useUiStore.getState().setSidebarItem('queue')
      useUiStore.getState().setChatOpen(false)
    })

    expect(useUiStore.getState()).toMatchObject({
      sidebarItem: 'queue',
      chatOpen: false,
    })
  })

  it('extended PrinterSnapshot includes all T01/T02 fields with correct types', async () => {
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')

    // Verify every field exists on default state
    const keys = Object.keys(PRINTER_DEFAULT_STATE)
    expect(keys).toContain('connectionState')
    expect(keys).toContain('chamberTemp')
    expect(keys).toContain('gcodeState')
    expect(keys).toContain('printProgress')
    expect(keys).toContain('remainingTime')
    expect(keys).toContain('layerNum')
    expect(keys).toContain('totalLayerNum')
    expect(keys).toContain('subtaskName')
    expect(keys).toContain('wifiSignal')
    expect(keys).toContain('amsState')
    expect(keys).toContain('lastError')
    expect(keys).toContain('nozzleTargetTemp')
    expect(keys).toContain('bedTargetTemp')

    // Default values
    expect(PRINTER_DEFAULT_STATE.connectionState).toBe('disconnected')
    expect(PRINTER_DEFAULT_STATE.amsState).toEqual([])
  })

  it('applySnapshot with partial connection state update preserves other fields (delta behavior)', async () => {
    const { usePrinterStore, applyPrinterSnapshot } = await import('../stores/printer')

    // Set initial connected state with telemetry
    act(() => {
      applyPrinterSnapshot({
        isConnected: true,
        connectionState: 'connected_mqtt',
        name: 'AOJDevStudio',
        nozzleTemp: 220,
        bedTemp: 60,
        chamberTemp: 35,
      })
    })

    expect(usePrinterStore.getState().connectionState).toBe('connected_mqtt')
    expect(usePrinterStore.getState().nozzleTemp).toBe(220)

    // Partial update: only temps change (like a delta push_status)
    act(() => {
      applyPrinterSnapshot({
        nozzleTemp: 221,
        bedTemp: 59,
      })
    })

    // Connection state and name preserved
    expect(usePrinterStore.getState().connectionState).toBe('connected_mqtt')
    expect(usePrinterStore.getState().name).toBe('AOJDevStudio')
    expect(usePrinterStore.getState().nozzleTemp).toBe(221)
    expect(usePrinterStore.getState().chamberTemp).toBe(35)
  })

  it('simulates full state transition sequence via sequential applySnapshot calls', async () => {
    const { usePrinterStore, applyPrinterSnapshot } = await import('../stores/printer')

    // Initial: disconnected
    expect(usePrinterStore.getState().connectionState).toBe('disconnected')

    // Transition: discovering
    act(() => {
      applyPrinterSnapshot({ connectionState: 'discovering' })
    })
    expect(usePrinterStore.getState().connectionState).toBe('discovering')

    // Transition: connected_mqtt with telemetry
    act(() => {
      applyPrinterSnapshot({
        isConnected: true,
        connectionState: 'connected_mqtt',
        connectionType: 'mqtt',
        name: 'AOJDevStudio',
        nozzleTemp: 25.3,
        bedTemp: 23.1,
        chamberTemp: 22.5,
        gcodeState: 'IDLE',
      })
    })
    expect(usePrinterStore.getState().connectionState).toBe('connected_mqtt')
    expect(usePrinterStore.getState().isConnected).toBe(true)
    expect(usePrinterStore.getState().gcodeState).toBe('IDLE')

    // Transition: reconnecting (network drop)
    act(() => {
      applyPrinterSnapshot({
        connectionState: 'reconnecting',
        isConnected: false,
        lastError: 'MQTT connection lost',
      })
    })
    expect(usePrinterStore.getState().connectionState).toBe('reconnecting')
    expect(usePrinterStore.getState().lastError).toBe('MQTT connection lost')
    // Name preserved from previous state
    expect(usePrinterStore.getState().name).toBe('AOJDevStudio')

    // Transition: back to connected_cloud (fallback)
    act(() => {
      applyPrinterSnapshot({
        connectionState: 'connected_cloud',
        connectionType: 'cloud',
        isConnected: true,
        lastError: null,
      })
    })
    expect(usePrinterStore.getState().connectionState).toBe('connected_cloud')
    expect(usePrinterStore.getState().lastError).toBeNull()
  })

  it('handles AMS state in printer snapshot', async () => {
    const { usePrinterStore, applyPrinterSnapshot } = await import('../stores/printer')

    act(() => {
      applyPrinterSnapshot({
        amsState: [
          {
            id: 0,
            trays: [
              { trayId: 0, trayType: 'PLA', trayColor: 'FF0000' },
              { trayId: 1, trayType: 'PETG', trayColor: '0000FF' },
            ],
          },
        ],
      })
    })

    const state = usePrinterStore.getState()
    expect(state.amsState).toHaveLength(1)
    expect(state.amsState[0].trays).toHaveLength(2)
    expect(state.amsState[0].trays[0].trayType).toBe('PLA')
  })
})
