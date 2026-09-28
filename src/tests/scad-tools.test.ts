// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Tauri mocks ──
// vi.mock factories are hoisted — cannot reference local variables.
// Use vi.fn() inline and import the mock later.

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
const invokeMock = vi.mocked(invoke)

// ── Store setup ──

import {
  useOpenScadStore,
  OPENSCAD_DEFAULT_STATE,
  type OpenScadSnapshot,
} from '../stores/openscadStore'

describe('create_scad tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
  })

  it('happy path: writes file, compiles, returns structured result', async () => {
    const { createScadTool } = await import('../agent/tools/create-scad')

    // Mock invoke responses in sequence
    invokeMock
      .mockResolvedValueOnce('/tmp/designs') // get_designs_dir
      .mockResolvedValueOnce(undefined) // write_text_file
      .mockResolvedValueOnce({ parameters: [{ name: 'width', type: 'number', initial: 10 }] }) // openscad_extract_params
      .mockResolvedValueOnce({ stlPath: '/tmp/out.stl', stderrWarnings: [], durationMs: 200 }) // openscad_render
      .mockResolvedValueOnce(undefined) // set_active_view

    const result = await createScadTool.execute('test-1', {
      description: 'Test Cube',
      code: 'cube([10,10,10]);',
    })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Design created successfully')
    expect(result.content[0].text).toContain('test-cube-')
    expect(result.content[0].text).toContain('/tmp/out.stl')
    expect(result.content[0].text).toContain('width: 10')
    expect(result.details).toHaveProperty('stlPath', '/tmp/out.stl')
    expect(result.details).toHaveProperty('scadPath')

    // Verify invoke calls
    expect(invokeMock).toHaveBeenCalledWith('get_designs_dir')
    expect(invokeMock).toHaveBeenCalledWith('write_text_file', expect.objectContaining({
      content: 'cube([10,10,10]);',
    }))
    expect(invokeMock).toHaveBeenCalledWith('openscad_render', expect.objectContaining({
      overrides: null,
    }))
  })

  it('compile error: returns structured error with line number', async () => {
    const { createScadTool } = await import('../agent/tools/create-scad')

    // Set up the store to have a compile error (simulating what Tauri event would set)
    invokeMock
      .mockResolvedValueOnce('/tmp/designs') // get_designs_dir
      .mockResolvedValueOnce(undefined) // write_text_file
      .mockResolvedValueOnce({ parameters: [] }) // openscad_extract_params
      .mockRejectedValueOnce(new Error('compilation failed')) // openscad_render

    // Pre-set the error that the Tauri event handler would set
    useOpenScadStore.setState({
      lastError: { line: 5, message: 'Unknown module "cubes"', fullStderr: '' },
    })

    const result = await createScadTool.execute('test-2', {
      description: 'Bad Design',
      code: 'cubes([10,10,10]);',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Compile error')
    expect(result.content[0].text).toContain('Line 5')
    expect(result.content[0].text).toContain('Unknown module "cubes"')
    expect(result.content[0].text).toContain('modify_scad')
  })
})

describe('modify_scad tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
  })

  it('happy path: updates file, compiles, returns result', async () => {
    const { modifyScadTool } = await import('../agent/tools/modify-scad')

    // Set up loaded file
    useOpenScadStore.setState({ loadedFile: '/tmp/designs/test.scad' })

    invokeMock
      .mockResolvedValueOnce(undefined) // write_text_file
      .mockResolvedValueOnce({ parameters: [{ name: 'height', type: 'number', initial: 20 }] }) // openscad_extract_params
      .mockResolvedValueOnce({ stlPath: '/tmp/out2.stl', stderrWarnings: [], durationMs: 150 }) // openscad_render

    const result = await modifyScadTool.execute('test-3', {
      code: 'cube([10,10,20]);',
    })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('updated and compiled successfully')
    expect(result.content[0].text).toContain('/tmp/out2.stl')
    expect(invokeMock).toHaveBeenCalledWith('write_text_file', {
      path: '/tmp/designs/test.scad',
      content: 'cube([10,10,20]);',
    })
  })

  it('no file loaded: returns error', async () => {
    const { modifyScadTool } = await import('../agent/tools/modify-scad')

    // No loadedFile set (default state)
    const result = await modifyScadTool.execute('test-4', {
      code: 'cube([10,10,10]);',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No design file is currently loaded')
    expect(result.content[0].text).toContain('create_scad')
    // No invoke calls should have been made
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('compile error: returns structured error', async () => {
    const { modifyScadTool } = await import('../agent/tools/modify-scad')

    useOpenScadStore.setState({ loadedFile: '/tmp/designs/test.scad' })

    invokeMock
      .mockResolvedValueOnce(undefined) // write_text_file
      .mockResolvedValueOnce({ parameters: [] }) // openscad_extract_params
      .mockRejectedValueOnce(new Error('syntax error')) // openscad_render

    useOpenScadStore.setState({
      loadedFile: '/tmp/designs/test.scad',
      lastError: { line: 3, message: 'Syntax error', fullStderr: '' },
    })

    const result = await modifyScadTool.execute('test-5', {
      code: 'bad code;',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Compile error')
    expect(result.content[0].text).toContain('Line 3')
    expect(result.content[0].text).toContain('modify_scad')
  })
})

describe('set_scad_parameters tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
  })

  it('happy path: updates parameters and re-renders', async () => {
    const { setScadParametersTool } = await import('../agent/tools/set-scad-parameters')

    useOpenScadStore.setState({
      loadedFile: '/tmp/designs/param-test.scad',
      parameters: [
        { name: 'width', type: 'number', initial: 10, min: null, max: null, step: null, group: null, caption: null },
        { name: 'height', type: 'number', initial: 20, min: null, max: null, step: null, group: null, caption: null },
      ],
    })

    invokeMock.mockResolvedValueOnce({
      stlPath: '/tmp/param-out.stl',
      stderrWarnings: [],
      durationMs: 100,
    }) // openscad_render

    const result = await setScadParametersTool.execute('test-6', {
      parameters: { width: 25, height: 30 },
    })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('Parameters updated')
    expect(result.content[0].text).toContain('width: 25')
    expect(result.content[0].text).toContain('height: 30')

    // Verify the store was updated
    const state = useOpenScadStore.getState()
    const widthParam = state.parameters.find((p) => p.name === 'width')
    expect(widthParam?.initial).toBe(25)

    // Verify render was called with overrides
    expect(invokeMock).toHaveBeenCalledWith('openscad_render', {
      path: '/tmp/designs/param-test.scad',
      overrides: expect.objectContaining({ width: '25', height: '30' }),
    })
  })

  it('no file loaded: returns error', async () => {
    const { setScadParametersTool } = await import('../agent/tools/set-scad-parameters')

    const result = await setScadParametersTool.execute('test-7', {
      parameters: { width: 25 },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No design file is currently loaded')
  })
})

describe('render_scad_preview tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
  })

  it('happy path: renders and switches to design view', async () => {
    const { renderScadPreviewTool } = await import('../agent/tools/render-scad-preview')

    useOpenScadStore.setState({
      loadedFile: '/tmp/designs/preview-test.scad',
      parameters: [
        { name: 'size', type: 'number', initial: 15, min: null, max: null, step: null, group: null, caption: null },
      ],
    })

    invokeMock
      .mockResolvedValueOnce({ stlPath: '/tmp/preview.stl', stderrWarnings: ['minor warning'], durationMs: 300 }) // openscad_render
      .mockResolvedValueOnce(undefined) // set_active_view

    const result = await renderScadPreviewTool.execute('test-8', {})

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('rendered successfully')
    expect(result.content[0].text).toContain('/tmp/preview.stl')
    expect(result.content[0].text).toContain('300ms')
    expect(result.content[0].text).toContain('minor warning')

    // Verify set_active_view was called with 'scad'
    expect(invokeMock).toHaveBeenCalledWith('set_active_view', { view: 'scad' })

    // Verify render was called with overrides
    expect(invokeMock).toHaveBeenCalledWith('openscad_render', {
      path: '/tmp/designs/preview-test.scad',
      overrides: { size: '15' },
    })
  })

  it('no file loaded: returns error', async () => {
    const { renderScadPreviewTool } = await import('../agent/tools/render-scad-preview')

    const result = await renderScadPreviewTool.execute('test-9', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('No design file is currently loaded')
  })

  it('render failure: returns structured compile error', async () => {
    const { renderScadPreviewTool } = await import('../agent/tools/render-scad-preview')

    useOpenScadStore.setState({
      loadedFile: '/tmp/designs/broken.scad',
      parameters: [],
      lastError: { line: 12, message: 'Undefined variable "x"', fullStderr: '' },
    })

    invokeMock.mockRejectedValueOnce(new Error('render failed')) // openscad_render

    const result = await renderScadPreviewTool.execute('test-10', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Render failed')
    expect(result.content[0].text).toContain('Line 12')
    expect(result.content[0].text).toContain('Undefined variable "x"')
  })
})
