/**
 * Tests for DesignTab composition and ParameterPanel.
 *
 * Covers:
 * - DesignTab renders empty state when no file loaded
 * - DesignTab renders 3-pane layout when file is loaded
 * - ParameterPanel renders sliders for number params with min/max/step
 * - ParameterPanel groups parameters by group field
 * - Parameter change triggers debounced render
 * - Open file button exists
 * - Error state displays error info
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { useOpenScadStore, OPENSCAD_DEFAULT_STATE, debouncedRender } from '../stores/openscadStore'
import type { ScadParameter } from '../stores/openscadStore'

// ─── Mock Tauri invoke ────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_text_file') {
      return 'cube([10, 10, 10]);'
    }
    if (cmd === 'write_text_file') {
      return null
    }
    return null
  }),
}))

// ─── Mock @tauri-apps/plugin-dialog ───────────────────────────────────────────

const mockDialogOpen = vi.fn()
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: any[]) => mockDialogOpen(...args),
}))

// ─── Mock Monaco editor ───────────────────────────────────────────────────────

vi.mock('@monaco-editor/react', () => {
  const MockEditor = (props: any) => {
    return (
      <div data-testid="mock-monaco-editor" data-language={props.language}>
        {props.defaultValue}
      </div>
    )
  }
  return {
    default: MockEditor,
    loader: { config: vi.fn() },
  }
})

vi.mock('monaco-editor', () => ({
  default: {},
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
  languages: {
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
    setLanguageConfiguration: vi.fn(),
    getLanguages: vi.fn(() => []),
  },
}))

// ─── Mock Tauri event hook ────────────────────────────────────────────────────

vi.mock('../hooks/useTauriEvent', () => ({
  default: vi.fn(),
}))

// ─── Mock ModelViewer (Canvas requires WebGL) ─────────────────────────────────

vi.mock('../components/ModelViewer', () => ({
  ModelViewer: ({ modelPath }: { modelPath?: string | null }) => (
    <div data-testid="model-viewer" data-model-path={modelPath ?? ''}>
      ModelViewer
    </div>
  ),
}))

// ─── Test Parameters ──────────────────────────────────────────────────────────

const testParams: ScadParameter[] = [
  {
    name: 'width',
    type: 'number',
    initial: 20,
    min: 5,
    max: 100,
    step: 1,
    group: 'Dimensions',
    caption: 'Width',
  },
  {
    name: 'height',
    type: 'number',
    initial: 30,
    min: 5,
    max: 200,
    step: 0.5,
    group: 'Dimensions',
    caption: 'Height',
  },
  {
    name: 'label_text',
    type: 'string',
    initial: 'Hello',
    min: null,
    max: null,
    step: null,
    group: 'Label',
    caption: 'Text',
  },
  {
    name: 'wall_thickness',
    type: 'number',
    initial: 2,
    min: null,
    max: null,
    step: null,
    group: null,
    caption: null,
  },
]

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DesignTab', () => {
  beforeEach(() => {
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
    mockDialogOpen.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows empty state when no file is loaded', async () => {
    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    expect(screen.getByTestId('design-tab-empty')).toBeTruthy()
    expect(screen.getByText('No file open')).toBeTruthy()
    expect(screen.getByText(/Open an OpenSCAD file/)).toBeTruthy()
  })

  it('has an Open File button in empty state', async () => {
    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    const button = screen.getByTestId('open-file-button')
    expect(button).toBeTruthy()
    expect(button.textContent).toContain('Open')
  })

  it('renders 3-pane layout when file is loaded', async () => {
    useOpenScadStore.setState({
      loadedFile: '/test/box.scad',
      parameters: testParams,
      renderStatus: 'idle',
      lastStlPath: null,
      lastError: null,
    })

    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    await waitFor(() => {
      expect(screen.getByTestId('editor-pane')).toBeTruthy()
      expect(screen.getByTestId('param-pane')).toBeTruthy()
      expect(screen.getByTestId('preview-pane')).toBeTruthy()
    })
  })

  it('displays filename in toolbar when file is loaded', async () => {
    useOpenScadStore.setState({
      loadedFile: '/Users/me/models/parametric-box.scad',
      parameters: [],
      renderStatus: 'idle',
      lastStlPath: null,
      lastError: null,
    })

    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    await waitFor(() => {
      expect(screen.getByText('parametric-box.scad')).toBeTruthy()
    })
  })

  it('shows render status indicator', async () => {
    useOpenScadStore.setState({
      loadedFile: '/test/box.scad',
      parameters: [],
      renderStatus: 'rendering',
      lastStlPath: null,
      lastError: null,
    })

    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    await waitFor(() => {
      expect(screen.getByTestId('render-status')).toBeTruthy()
      expect(screen.getByText('Rendering…')).toBeTruthy()
    })
  })

  it('displays error info in toolbar when error exists', async () => {
    useOpenScadStore.setState({
      loadedFile: '/test/box.scad',
      parameters: [],
      renderStatus: 'error',
      lastStlPath: null,
      lastError: { line: 5, message: 'Expected ;', fullStderr: 'ERROR: Expected ;' },
    })

    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    await waitFor(() => {
      expect(screen.getByText(/Line 5/)).toBeTruthy()
      expect(screen.getByText(/Expected ;/)).toBeTruthy()
    })
  })

  it('passes lastStlPath to ModelViewer', async () => {
    useOpenScadStore.setState({
      loadedFile: '/test/box.scad',
      parameters: [],
      renderStatus: 'idle',
      lastStlPath: '/tmp/output.stl',
      lastError: null,
    })

    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    await waitFor(() => {
      const viewer = screen.getByTestId('model-viewer')
      expect(viewer.getAttribute('data-model-path')).toBe('/tmp/output.stl')
    })
  })

  it('calls dialog open with scad filter when Open File clicked', async () => {
    mockDialogOpen.mockResolvedValue(null)

    const { default: DesignTab } = await import('../components/DesignTab')
    render(<DesignTab />)

    const button = screen.getByTestId('open-file-button')
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockDialogOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [{ name: 'OpenSCAD', extensions: ['scad'] }],
        }),
      )
    })
  })
})

describe('ParameterPanel', () => {
  beforeEach(() => {
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows empty state when no parameters', async () => {
    const { default: ParameterPanel } = await import('../components/ParameterPanel')
    render(<ParameterPanel />)

    expect(screen.getByText('No parameters')).toBeTruthy()
  })

  it('renders sliders for number params with min/max', async () => {
    useOpenScadStore.setState({
      ...OPENSCAD_DEFAULT_STATE,
      parameters: testParams,
    })

    const { default: ParameterPanel } = await import('../components/ParameterPanel')
    render(<ParameterPanel />)

    // Width slider
    const widthSlider = screen.getByRole('slider', { name: 'Width' })
    expect(widthSlider).toBeTruthy()
    expect(widthSlider.getAttribute('min')).toBe('5')
    expect(widthSlider.getAttribute('max')).toBe('100')
    expect(widthSlider.getAttribute('step')).toBe('1')

    // Height slider
    const heightSlider = screen.getByRole('slider', { name: 'Height' })
    expect(heightSlider).toBeTruthy()
    expect(heightSlider.getAttribute('min')).toBe('5')
    expect(heightSlider.getAttribute('max')).toBe('200')
    expect(heightSlider.getAttribute('step')).toBe('0.5')
  })

  it('renders text input for string params', async () => {
    useOpenScadStore.setState({
      ...OPENSCAD_DEFAULT_STATE,
      parameters: testParams,
    })

    const { default: ParameterPanel } = await import('../components/ParameterPanel')
    render(<ParameterPanel />)

    const textInput = screen.getByRole('textbox', { name: 'Text' })
    expect(textInput).toBeTruthy()
    expect((textInput as HTMLInputElement).value).toBe('Hello')
  })

  it('renders number input for numbers without range', async () => {
    useOpenScadStore.setState({
      ...OPENSCAD_DEFAULT_STATE,
      parameters: testParams,
    })

    const { default: ParameterPanel } = await import('../components/ParameterPanel')
    render(<ParameterPanel />)

    // wall_thickness has no min/max, so it should be a spinbutton (number input)
    const numberInput = screen.getByRole('spinbutton', { name: 'wall_thickness' })
    expect(numberInput).toBeTruthy()
    expect((numberInput as HTMLInputElement).value).toBe('2')
  })

  it('groups parameters by group field', async () => {
    useOpenScadStore.setState({
      ...OPENSCAD_DEFAULT_STATE,
      parameters: testParams,
    })

    const { default: ParameterPanel } = await import('../components/ParameterPanel')
    render(<ParameterPanel />)

    // Should have group headers for Dimensions and Label (3 groups total, but
    // the "Parameters" default group header only shows when > 1 group)
    expect(screen.getByText('Dimensions')).toBeTruthy()
    expect(screen.getByText('Label')).toBeTruthy()
    // "Parameters" is the default group name — appears as group header
    expect(screen.getAllByText('Parameters').length).toBeGreaterThanOrEqual(1)
  })

  it('updates store parameter on slider change', async () => {
    useOpenScadStore.setState({
      ...OPENSCAD_DEFAULT_STATE,
      parameters: testParams,
    })

    const { default: ParameterPanel } = await import('../components/ParameterPanel')
    render(<ParameterPanel />)

    const widthSlider = screen.getByRole('slider', { name: 'Width' })
    fireEvent.change(widthSlider, { target: { value: '50' } })

    // Check store was updated
    const state = useOpenScadStore.getState()
    const widthParam = state.parameters.find((p) => p.name === 'width')
    expect(widthParam?.initial).toBe(50)
  })

  it('triggers debounced render on parameter change', async () => {
    // Mock the render function
    const renderMock = vi.fn().mockResolvedValue({
      stlPath: '/tmp/out.stl',
      stderrWarnings: [],
      durationMs: 100,
    })

    useOpenScadStore.setState({
      ...OPENSCAD_DEFAULT_STATE,
      loadedFile: '/test/box.scad',
      parameters: testParams,
      render: renderMock,
    })

    const { default: ParameterPanel } = await import('../components/ParameterPanel')
    render(<ParameterPanel />)

    const widthSlider = screen.getByRole('slider', { name: 'Width' })
    fireEvent.change(widthSlider, { target: { value: '50' } })

    // Wait for debounce (300ms)
    await vi.waitFor(
      () => {
        expect(renderMock).toHaveBeenCalled()
      },
      { timeout: 500 },
    )
  })
})
