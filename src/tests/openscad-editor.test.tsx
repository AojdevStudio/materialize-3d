/**
 * Tests for OpenScadEditor component integration logic.
 *
 * Monaco is not fully functional in jsdom, so we test:
 * - Language registration logic
 * - Error marker application logic
 * - Save callback wiring
 * - Theme definition
 *
 * We mock Monaco and @monaco-editor/react to isolate integration behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { useOpenScadStore, OPENSCAD_DEFAULT_STATE } from '../stores/openscadStore'
import {
  registerOpenScadLanguage,
  OPENSCAD_LANGUAGE_ID,
  openscadMonarchTokens,
  openscadLanguageConfig,
} from '../languages/openscad'
import {
  definematerializeTheme,
  MATERIALIZE_THEME_ID,
  materializeDarkTheme,
} from '../languages/materialize-theme'

// ─── Mock Tauri invoke ────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'read_text_file') {
      const path = args?.path as string
      if (path === '/test/valid.scad') {
        return 'cube([10, 10, 10]);'
      }
      if (path === '/test/missing.scad') {
        throw new Error('File not found: /test/missing.scad')
      }
      return '// empty'
    }
    return null
  }),
}))

// ─── Mock @monaco-editor/react ────────────────────────────────────────────────

// Capture onMount callback so we can invoke it in tests
let capturedOnMount: ((editor: any, monaco: any) => void) | null = null

vi.mock('@monaco-editor/react', () => {
  const MockEditor = (props: any) => {
    // Capture the onMount callback for test invocation
    capturedOnMount = props.onMount || null
    return <div data-testid="mock-monaco-editor" data-language={props.language} data-theme={props.theme}>{props.defaultValue}</div>
  }

  return {
    default: MockEditor,
    loader: {
      config: vi.fn(),
    },
  }
})

// Mock monaco-editor import used by the component to configure loader
vi.mock('monaco-editor', () => ({
  default: {},
  editor: { defineTheme: vi.fn(), setTheme: vi.fn() },
  languages: { register: vi.fn(), setMonarchTokensProvider: vi.fn(), setLanguageConfiguration: vi.fn(), getLanguages: vi.fn(() => []) },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockMonaco() {
  return {
    languages: {
      getLanguages: vi.fn(() => []),
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
    },
    editor: {
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      setModelMarkers: vi.fn(),
      setModelLanguage: vi.fn(),
    },
    MarkerSeverity: {
      Error: 8,
      Warning: 4,
      Info: 2,
      Hint: 1,
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
  }
}

function createMockEditor(content = 'cube([10, 10, 10]);') {
  const model = {
    getLineMaxColumn: vi.fn((line: number) => 20),
  }
  return {
    getModel: vi.fn(() => model),
    getValue: vi.fn(() => content),
    addAction: vi.fn(),
    focus: vi.fn(),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OpenSCAD Language Registration', () => {
  it('registers the openscad language with Monaco', () => {
    const mockMonaco = createMockMonaco() as any

    registerOpenScadLanguage(mockMonaco)

    expect(mockMonaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: OPENSCAD_LANGUAGE_ID,
        extensions: ['.scad'],
      }),
    )
    expect(mockMonaco.languages.setMonarchTokensProvider).toHaveBeenCalledWith(
      OPENSCAD_LANGUAGE_ID,
      openscadMonarchTokens,
    )
    expect(mockMonaco.languages.setLanguageConfiguration).toHaveBeenCalledWith(
      OPENSCAD_LANGUAGE_ID,
      openscadLanguageConfig,
    )
  })

  it('does not re-register if already present', () => {
    const mockMonaco = createMockMonaco() as any
    mockMonaco.languages.getLanguages.mockReturnValue([{ id: OPENSCAD_LANGUAGE_ID }])

    registerOpenScadLanguage(mockMonaco)

    expect(mockMonaco.languages.register).not.toHaveBeenCalled()
  })

  it('tokenizer includes all required keyword categories', () => {
    expect(openscadMonarchTokens.keywords).toContain('module')
    expect(openscadMonarchTokens.keywords).toContain('function')
    expect(openscadMonarchTokens.keywords).toContain('cube')
    expect(openscadMonarchTokens.keywords).toContain('linear_extrude')
    expect(openscadMonarchTokens.keywords).toContain('hull')
    expect(openscadMonarchTokens.keywords).toContain('minkowski')
    expect(openscadMonarchTokens.builtinConstants).toContain('true')
    expect(openscadMonarchTokens.builtinConstants).toContain('false')
    expect(openscadMonarchTokens.builtinConstants).toContain('undef')
    expect(openscadMonarchTokens.builtinVariables).toContain('$fn')
    expect(openscadMonarchTokens.builtinVariables).toContain('$fa')
    expect(openscadMonarchTokens.builtinVariables).toContain('$fs')
  })
})

describe('Materialize Theme', () => {
  it('defines the custom dark theme', () => {
    const mockMonaco = createMockMonaco() as any

    definematerializeTheme(mockMonaco)

    expect(mockMonaco.editor.defineTheme).toHaveBeenCalledWith(
      MATERIALIZE_THEME_ID,
      materializeDarkTheme,
    )
  })

  it('inherits from vs-dark', () => {
    expect(materializeDarkTheme.base).toBe('vs-dark')
    expect(materializeDarkTheme.inherit).toBe(true)
  })

  it('uses app design token colors', () => {
    expect(materializeDarkTheme.colors['editor.background']).toBe('#111114')
    expect(materializeDarkTheme.colors['editor.foreground']).toBe('#e8e6e3')
    expect(materializeDarkTheme.colors['editorCursor.foreground']).toBe('#e8682a')
  })
})

describe('OpenScadEditor Component', () => {
  beforeEach(() => {
    capturedOnMount = null
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
  })

  afterEach(() => {
    cleanup()
  })

  it('renders loading state initially', async () => {
    // Lazy import to ensure mocks are applied
    const { default: OpenScadEditor } = await import('../components/OpenScadEditor')

    render(<OpenScadEditor filePath="/test/valid.scad" onSave={vi.fn()} />)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('renders editor after file loads', async () => {
    const { default: OpenScadEditor } = await import('../components/OpenScadEditor')

    render(<OpenScadEditor filePath="/test/valid.scad" onSave={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy()
    })

    const editor = screen.getByTestId('mock-monaco-editor')
    expect(editor.getAttribute('data-language')).toBe(OPENSCAD_LANGUAGE_ID)
    expect(editor.getAttribute('data-theme')).toBe(MATERIALIZE_THEME_ID)
  })

  it('shows error when file load fails', async () => {
    const { default: OpenScadEditor } = await import('../components/OpenScadEditor')

    render(<OpenScadEditor filePath="/test/missing.scad" onSave={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/Failed to load file/)).toBeTruthy()
    })
  })

  it('registers save action with Cmd+S keybinding on mount', async () => {
    const { default: OpenScadEditor } = await import('../components/OpenScadEditor')
    const onSave = vi.fn()

    render(<OpenScadEditor filePath="/test/valid.scad" onSave={onSave} />)

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy()
    })

    // Simulate Monaco calling onMount
    const mockMonaco = createMockMonaco()
    const mockEditor = createMockEditor()
    expect(capturedOnMount).toBeTruthy()
    capturedOnMount!(mockEditor, mockMonaco)

    // Verify save action was registered
    expect(mockEditor.addAction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'openscad-save',
        keybindings: expect.arrayContaining([expect.any(Number)]),
      }),
    )

    // Simulate the save action being triggered
    const saveAction = mockEditor.addAction.mock.calls[0][0]
    saveAction.run(mockEditor)
    expect(onSave).toHaveBeenCalledWith('cube([10, 10, 10]);')
  })

  it('registers OpenSCAD language and theme on mount', async () => {
    const { default: OpenScadEditor } = await import('../components/OpenScadEditor')

    render(<OpenScadEditor filePath="/test/valid.scad" onSave={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy()
    })

    const mockMonaco = createMockMonaco()
    const mockEditor = createMockEditor()
    capturedOnMount!(mockEditor, mockMonaco)

    // Language registered
    expect(mockMonaco.languages.register).toHaveBeenCalledWith(
      expect.objectContaining({ id: OPENSCAD_LANGUAGE_ID }),
    )

    // Theme defined and set
    expect(mockMonaco.editor.defineTheme).toHaveBeenCalledWith(
      MATERIALIZE_THEME_ID,
      materializeDarkTheme,
    )
    expect(mockMonaco.editor.setTheme).toHaveBeenCalledWith(MATERIALIZE_THEME_ID)
  })
})

describe('Error Marker Integration', () => {
  afterEach(() => {
    cleanup()
    useOpenScadStore.setState({ ...OPENSCAD_DEFAULT_STATE })
  })

  it('sets error markers when store has lastError', async () => {
    const { default: OpenScadEditor } = await import('../components/OpenScadEditor')

    render(<OpenScadEditor filePath="/test/valid.scad" onSave={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy()
    })

    // Mount the editor so refs are set
    const mockMonaco = createMockMonaco()
    const mockEditor = createMockEditor()
    capturedOnMount!(mockEditor, mockMonaco)

    // Simulate an error arriving from the store
    useOpenScadStore.setState({
      lastError: {
        line: 5,
        message: 'Expected ;',
        fullStderr: 'ERROR: Expected ; at line 5',
      },
    })

    await waitFor(() => {
      expect(mockMonaco.editor.setModelMarkers).toHaveBeenCalledWith(
        mockEditor.getModel(),
        'openscad',
        [
          expect.objectContaining({
            severity: 8, // MarkerSeverity.Error
            message: 'Expected ;',
            startLineNumber: 5,
            endLineNumber: 5,
          }),
        ],
      )
    })
  })

  it('clears markers when error is null', async () => {
    const { default: OpenScadEditor } = await import('../components/OpenScadEditor')

    // Start with an error
    useOpenScadStore.setState({
      lastError: {
        line: 3,
        message: 'Syntax error',
        fullStderr: 'ERROR: Syntax error at line 3',
      },
    })

    render(<OpenScadEditor filePath="/test/valid.scad" onSave={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('mock-monaco-editor')).toBeTruthy()
    })

    const mockMonaco = createMockMonaco()
    const mockEditor = createMockEditor()
    capturedOnMount!(mockEditor, mockMonaco)

    // Clear the error
    useOpenScadStore.setState({ lastError: null })

    await waitFor(() => {
      // Should have been called with empty array to clear markers
      const calls = mockMonaco.editor.setModelMarkers.mock.calls
      const lastCall = calls[calls.length - 1]
      expect(lastCall[2]).toEqual([])
    })
  })
})
