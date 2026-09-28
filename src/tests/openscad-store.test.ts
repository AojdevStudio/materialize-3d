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

// ── Tauri mocks ──

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

// ── Helpers ──

import type { OpenScadSnapshot, ScadParameter } from '../stores/openscadStore'

function makeParam(overrides: Partial<ScadParameter> = {}): ScadParameter {
  return {
    name: 'width',
    type: 'number',
    initial: 20,
    min: 5,
    max: 50,
    step: 1,
    group: 'Parameters',
    caption: null,
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<OpenScadSnapshot> = {}): OpenScadSnapshot {
  return {
    loadedFile: '/tmp/test.scad',
    parameters: [makeParam()],
    renderStatus: 'idle',
    lastStlPath: null,
    lastError: null,
    ...overrides,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('openscad store', () => {
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

    const { useOpenScadStore, OPENSCAD_DEFAULT_STATE } = await import(
      '../stores/openscadStore'
    )
    useOpenScadStore.setState(OPENSCAD_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('initializes with idle default state', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')
    const state = useOpenScadStore.getState()

    expect(state.loadedFile).toBeNull()
    expect(state.parameters).toEqual([])
    expect(state.renderStatus).toBe('idle')
    expect(state.lastStlPath).toBeNull()
    expect(state.lastError).toBeNull()
  })

  it('loadFile invokes openscad_extract_params and updates loadedFile', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')
    const params = [makeParam(), makeParam({ name: 'height', initial: 10 })]

    invokeMock.mockResolvedValue({ parameters: params, title: 'test' })

    const result = await useOpenScadStore.getState().loadFile('/tmp/box.scad')

    expect(invokeMock).toHaveBeenCalledWith('openscad_extract_params', {
      path: '/tmp/box.scad',
    })
    expect(result.parameters).toHaveLength(2)

    // Optimistic state should have been set
    const state = useOpenScadStore.getState()
    expect(state.loadedFile).toBe('/tmp/box.scad')
  })

  it('render invokes openscad_render with overrides', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')

    // Pre-set loadedFile
    useOpenScadStore.setState({ loadedFile: '/tmp/box.scad' })

    invokeMock.mockResolvedValue({
      stlPath: '/tmp/output.stl',
      stderrWarnings: [],
      durationMs: 150,
    })

    const overrides = { width: '40', height: '5' }
    const result = await useOpenScadStore.getState().render(overrides)

    expect(invokeMock).toHaveBeenCalledWith('openscad_render', {
      path: '/tmp/box.scad',
      overrides,
    })
    expect(result.stlPath).toBe('/tmp/output.stl')
  })

  it('render throws when no file is loaded', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')

    await expect(useOpenScadStore.getState().render()).rejects.toThrow(
      'No file loaded',
    )
  })

  it('render sets status to rendering optimistically', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')
    useOpenScadStore.setState({ loadedFile: '/tmp/box.scad' })

    // Don't resolve invoke — capture the intermediate state
    let resolveRender: (v: any) => void
    invokeMock.mockReturnValue(
      new Promise((r) => {
        resolveRender = r
      }),
    )

    const renderPromise = useOpenScadStore.getState().render()

    // Before resolve, status should be rendering
    expect(useOpenScadStore.getState().renderStatus).toBe('rendering')

    resolveRender!({
      stlPath: '/tmp/output.stl',
      stderrWarnings: [],
      durationMs: 100,
    })
    await renderPromise
  })

  it('updateParameter updates a single parameter by name', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')

    useOpenScadStore.setState({
      parameters: [
        makeParam({ name: 'width', initial: 20 }),
        makeParam({ name: 'height', initial: 10 }),
      ],
    })

    act(() => {
      useOpenScadStore.getState().updateParameter('width', 40)
    })

    const params = useOpenScadStore.getState().parameters
    expect(params[0].initial).toBe(40)
    expect(params[1].initial).toBe(10) // unchanged
  })

  it('clearFile resets to default state', async () => {
    const { useOpenScadStore, OPENSCAD_DEFAULT_STATE } = await import(
      '../stores/openscadStore'
    )

    useOpenScadStore.setState({
      loadedFile: '/tmp/box.scad',
      parameters: [makeParam()],
      renderStatus: 'idle',
      lastStlPath: '/tmp/output.stl',
    })

    act(() => {
      useOpenScadStore.getState().clearFile()
    })

    const state = useOpenScadStore.getState()
    expect(state.loadedFile).toBeNull()
    expect(state.parameters).toEqual([])
    expect(state.renderStatus).toBe('idle')
    expect(state.lastStlPath).toBeNull()
    expect(state.lastError).toBeNull()
  })

  it('applySnapshot updates store from Tauri event payload', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')

    const snapshot = makeSnapshot({
      loadedFile: '/tmp/ring.scad',
      renderStatus: 'idle',
      lastStlPath: '/tmp/ring.stl',
    })

    act(() => {
      useOpenScadStore.getState().applySnapshot(snapshot)
    })

    const state = useOpenScadStore.getState()
    expect(state.loadedFile).toBe('/tmp/ring.scad')
    expect(state.lastStlPath).toBe('/tmp/ring.stl')
    expect(state.parameters).toHaveLength(1)
  })

  it('subscribes to openscad:state-changed event and applies snapshot', async () => {
    const { useOpenScadEvents, useOpenScadStore } = await import(
      '../stores/openscadStore'
    )

    function TestBridge() {
      useOpenScadEvents()
      return null
    }

    render(React.createElement(TestBridge))

    expect(listenMock).toHaveBeenCalledWith(
      'openscad:state-changed',
      expect.any(Function),
    )

    // Simulate event from Rust
    emitEvent('openscad:state-changed', makeSnapshot({
      loadedFile: '/tmp/gear.scad',
      renderStatus: 'rendering',
    }))

    const state = useOpenScadStore.getState()
    expect(state.loadedFile).toBe('/tmp/gear.scad')
    expect(state.renderStatus).toBe('rendering')
  })

  it('event applies error snapshot with compile error', async () => {
    const { useOpenScadEvents, useOpenScadStore } = await import(
      '../stores/openscadStore'
    )

    function TestBridge() {
      useOpenScadEvents()
      return null
    }

    render(React.createElement(TestBridge))

    emitEvent('openscad:state-changed', makeSnapshot({
      renderStatus: 'error',
      lastError: {
        line: 5,
        message: 'ERROR: Parser error: syntax error',
        fullStderr: 'ERROR: Parser error: syntax error in file /tmp/test.scad, line 5',
      },
    }))

    const state = useOpenScadStore.getState()
    expect(state.renderStatus).toBe('error')
    expect(state.lastError).not.toBeNull()
    expect(state.lastError!.line).toBe(5)
    expect(state.lastError!.message).toContain('syntax error')
  })
})
