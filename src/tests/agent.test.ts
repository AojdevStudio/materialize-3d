// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'

// ── Tauri mocks ──

const invokeMock = vi.fn()
const listenMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

// ── Pi SDK mocks ──
// We mock the heavy SDK modules so agent creation doesn't need a real LLM connection

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn((_provider: string, _modelId: string) => ({
    id: _modelId,
    provider: _provider,
    api: 'messages',
  })),
  getProviders: vi.fn(() => ['anthropic', 'openai']),
  getModels: vi.fn((_provider: string) => [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4', provider: _provider, api: 'messages' },
  ]),
}))

vi.mock('@mariozechner/pi-web-ui', () => ({
  defaultConvertToLlm: vi.fn((messages: unknown[]) => messages),
  // Provide storage stubs needed by storage.ts if imported transitively
  AppStorage: vi.fn(),
  IndexedDBStorageBackend: vi.fn(),
  SettingsStore: vi.fn(() => ({ getConfig: vi.fn() })),
  ProviderKeysStore: vi.fn(() => ({ getConfig: vi.fn(), get: vi.fn() })),
  SessionsStore: Object.assign(vi.fn(() => ({ getConfig: vi.fn() })), {
    getMetadataConfig: vi.fn(),
  }),
  CustomProvidersStore: vi.fn(() => ({ getConfig: vi.fn() })),
  setAppStorage: vi.fn(),
}))

describe('agent: dynamic context builder', () => {
  beforeEach(async () => {
    // Reset stores to defaults
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useWorkspaceStore, WORKSPACE_DEFAULT_STATE } = await import('../stores/workspace')
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useWorkspaceStore.setState(WORKSPACE_DEFAULT_STATE)
  })

  it('includes printer connection state in context output', async () => {
    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Printer Status')
    expect(ctx).toContain('Connection: disconnected')
    expect(ctx).toContain('Name: (none)')
  })

  it('includes connected printer details when connected', async () => {
    const { usePrinterStore } = await import('../stores/printer')

    act(() => {
      usePrinterStore.getState().applySnapshot({
        isConnected: true,
        connectionState: 'connected_mqtt',
        name: 'AOJDevStudio',
        nozzleTemp: 220,
        nozzleTargetTemp: 220,
        bedTemp: 60,
        bedTargetTemp: 60,
        chamberTemp: 35,
        gcodeState: 'RUNNING',
        printProgress: 42,
        remainingTime: 1800,
      })
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('Name: AOJDevStudio')
    expect(ctx).toContain('Connection: connected_mqtt')
    expect(ctx).toContain('Nozzle: 220°C / target 220°C')
    expect(ctx).toContain('Bed: 60°C / target 60°C')
    expect(ctx).toContain('Chamber: 35°C')
    expect(ctx).toContain('GCode State: RUNNING')
    expect(ctx).toContain('Print Progress: 42%')
    expect(ctx).toContain('Remaining Time: 1800s')
  })

  it('includes AMS data when present', async () => {
    const { usePrinterStore } = await import('../stores/printer')

    act(() => {
      usePrinterStore.getState().applySnapshot({
        isConnected: true,
        connectionState: 'connected_mqtt',
        amsState: [
          {
            id: 0,
            trays: [
              { trayId: 1, trayType: 'PLA', trayColor: 'red' },
              { trayId: 2, trayType: 'PETG', trayColor: 'blue' },
            ],
          },
        ],
      })
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## AMS State')
    expect(ctx).toContain('Slot 1: PLA, red')
    expect(ctx).toContain('Slot 2: PETG, blue')
  })

  it('includes active model info when loaded', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace')

    act(() => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        activeModel: {
          id: '1',
          name: 'Headphone Hook',
          path: '/tmp/hook.3mf',
          source: 'makerworld',
          sizeBytes: 2400000,
        },
      })
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Active Model')
    expect(ctx).toContain('Name: Headphone Hook')
    expect(ctx).toContain('Path: /tmp/hook.3mf')
    expect(ctx).toContain('Source: makerworld')
  })

  it('includes current view', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace')

    act(() => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        activeView: 'browser',
      })
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Current View')
    expect(ctx).toContain('browser')
  })

  it('shows empty markers for null/disconnected states', async () => {
    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('(no AMS data)')
    expect(ctx).toContain('(no model loaded)')
  })

  it('exports SYSTEM_PROMPT constant', async () => {
    const { SYSTEM_PROMPT } = await import('../agent/context')
    expect(SYSTEM_PROMPT).toContain('Materialize 3D')
    expect(SYSTEM_PROMPT).toContain('3D printing')
    expect(SYSTEM_PROMPT).toContain('Bambu Lab')
  })
})

describe('agent: tool execution', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('get_printer_status calls invoke and returns formatted content', async () => {
    invokeMock.mockResolvedValue({
      isConnected: true,
      connectionState: 'connected_mqtt',
      name: 'AOJDevStudio',
      nozzleTemp: 220,
      nozzleTargetTemp: 220,
      bedTemp: 60,
      bedTargetTemp: 60,
      chamberTemp: 35,
      gcodeState: 'IDLE',
      printProgress: null,
      remainingTime: null,
      subtaskName: null,
      amsState: [],
    })

    const { getPrinterStatusTool } = await import('../agent/tools/get-printer-status')
    const result = await getPrinterStatusTool.execute('test-1', {}, new AbortController().signal)

    expect(invokeMock).toHaveBeenCalledWith('get_printer_status')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('AOJDevStudio')
    expect(result.content[0].text).toContain('connected_mqtt')
  })

  it('search_makerworld calls invoke with query', async () => {
    invokeMock.mockResolvedValue({})

    const { searchMakerworldTool } = await import('../agent/tools/search-makerworld')
    const result = await searchMakerworldTool.execute(
      'test-2',
      { query: 'headphone hook' },
      new AbortController().signal
    )

    expect(invokeMock).toHaveBeenCalledWith('search_makerworld', { query: 'headphone hook' })
    expect(result.content[0].text).toContain('headphone hook')
  })

  it('slice_model calls invoke with path, quality, filament', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      gcodeFile: '/tmp/out.gcode',
      estimatedTime: 2700,
      filamentUsed: 12.4,
      layerCount: 180,
      warnings: [],
    })

    const { sliceModelTool } = await import('../agent/tools/slice-model')
    const result = await sliceModelTool.execute(
      'test-3',
      { path: '/tmp/model.3mf', quality: '0.20mm', filament: 'PLA' },
      new AbortController().signal
    )

    expect(invokeMock).toHaveBeenCalledWith('slice_model', {
      path: '/tmp/model.3mf',
      quality: '0.20mm',
      filament: 'PLA',
    })
    expect(result.content[0].text).toContain('success')
    expect(result.content[0].text).toContain('45m')
    expect(result.content[0].text).toContain('12.4g')
    expect(result.content[0].text).toContain('180')
  })

  it('show_model calls set_active_view with preview', async () => {
    invokeMock.mockResolvedValue({})

    const { showModelTool } = await import('../agent/tools/show-model')
    const result = await showModelTool.execute(
      'test-4',
      { path: '/tmp/model.3mf' },
      new AbortController().signal
    )

    expect(invokeMock).toHaveBeenCalledWith('set_active_view', { view: 'preview' })
    expect(result.content[0].text).toContain('preview')
    expect(result.content[0].text).toContain('/tmp/model.3mf')
  })

  it('navigate_to calls set_active_view with requested view', async () => {
    invokeMock.mockResolvedValue({})

    const { navigateToTool } = await import('../agent/tools/navigate-to')
    const result = await navigateToTool.execute(
      'test-5',
      { view: 'monitor' },
      new AbortController().signal
    )

    expect(invokeMock).toHaveBeenCalledWith('set_active_view', { view: 'monitor' })
    expect(result.content[0].text).toContain('Printer Monitor')
  })

  it('download_model calls invoke and returns import status', async () => {
    invokeMock.mockResolvedValue({
      importStatus: 'imported',
      importedFiles: ['/tmp/model/headphone-hook.3mf'],
    })

    const { downloadModelTool } = await import('../agent/tools/download-model')
    const result = await downloadModelTool.execute('test-dl-1', {}, new AbortController().signal)

    expect(invokeMock).toHaveBeenCalledWith('download_model')
    expect(result.content[0].text).toContain('imported')
    expect(result.content[0].text).toContain('headphone-hook.3mf')
  })

  it('download_model handles errors gracefully', async () => {
    invokeMock.mockRejectedValue(new Error('No model detected on current page'))

    const { downloadModelTool } = await import('../agent/tools/download-model')
    const result = await downloadModelTool.execute('test-dl-err', {}, new AbortController().signal)

    expect(result.content[0].text).toContain('Error downloading model')
    expect((result as any).isError).toBe(true)
  })

  it('start_print calls invoke with path and returns result', async () => {
    invokeMock.mockResolvedValue({
      success: true,
      filename: 'benchy.3mf',
      md5: 'abc123',
      error: null,
    })

    const { startPrintTool } = await import('../agent/tools/start-print')
    const result = await startPrintTool.execute(
      'test-sp-1',
      { threemf_path: '/tmp/benchy.3mf' },
      new AbortController().signal
    )

    expect(invokeMock).toHaveBeenCalledWith('start_print', { path: '/tmp/benchy.3mf' })
    expect(result.content[0].text).toContain('Print started successfully')
    expect(result.content[0].text).toContain('benchy.3mf')
    expect(result.content[0].text).toContain('abc123')
  })

  it('start_print reports failure from backend', async () => {
    invokeMock.mockResolvedValue({
      success: false,
      filename: 'model.3mf',
      md5: '',
      error: 'FTPS connect failed: timeout',
    })

    const { startPrintTool } = await import('../agent/tools/start-print')
    const result = await startPrintTool.execute(
      'test-sp-2',
      { threemf_path: '/tmp/model.3mf' },
      new AbortController().signal
    )

    expect(result.content[0].text).toContain('Print failed to start')
    expect(result.content[0].text).toContain('FTPS connect failed')
  })

  it('start_print handles invoke rejection', async () => {
    invokeMock.mockRejectedValue(new Error('Printer not connected'))

    const { startPrintTool } = await import('../agent/tools/start-print')
    const result = await startPrintTool.execute(
      'test-sp-err',
      { threemf_path: '/tmp/model.3mf' },
      new AbortController().signal
    )

    expect(result.content[0].text).toContain('Error starting print')
    expect((result as any).isError).toBe(true)
  })

  it('tool handles errors gracefully with isError flag', async () => {
    invokeMock.mockRejectedValue(new Error('Connection refused'))

    const { getPrinterStatusTool } = await import('../agent/tools/get-printer-status')
    const result = await getPrinterStatusTool.execute('test-err', {}, new AbortController().signal)

    expect(result.content[0].text).toContain('Error')
    expect(result.content[0].text).toContain('Connection refused')
    expect((result as any).isError).toBe(true)
  })

  it('slice_model handles errors gracefully', async () => {
    invokeMock.mockRejectedValue(new Error('File not found'))

    const { sliceModelTool } = await import('../agent/tools/slice-model')
    const result = await sliceModelTool.execute(
      'test-err-2',
      { path: '/nonexistent.3mf' },
      new AbortController().signal
    )

    expect(result.content[0].text).toContain('Error slicing model')
    expect((result as any).isError).toBe(true)
  })
})

describe('agent: tool registry', () => {
  it('exports 11 tools with correct names', async () => {
    const { agentTools } = await import('../agent/tools')

    expect(agentTools).toHaveLength(11)
    const names = agentTools.map((t) => t.name)
    expect(names).toContain('get_printer_status')
    expect(names).toContain('search_makerworld')
    expect(names).toContain('slice_model')
    expect(names).toContain('show_model')
    expect(names).toContain('navigate_to')
    expect(names).toContain('download_model')
    expect(names).toContain('start_print')
    expect(names).toContain('create_scad')
    expect(names).toContain('modify_scad')
    expect(names).toContain('set_scad_parameters')
    expect(names).toContain('render_scad_preview')
  })

  it('all tools have required AgentTool fields', async () => {
    const { agentTools } = await import('../agent/tools')

    for (const tool of agentTools) {
      expect(tool.name).toBeTruthy()
      expect(tool.label).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.parameters).toBeTruthy()
      expect(typeof tool.execute).toBe('function')
    }
  })
})

describe('agent: getAgent singleton', () => {
  it('creates an Agent instance with all 11 tools', async () => {
    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    expect(agent).toBeDefined()
    expect(agent.state).toBeDefined()
    expect(agent.state.tools).toHaveLength(11)
    expect(agent.state.systemPrompt).toContain('Materialize 3D')
  })

  it('agent has correct model configured', async () => {
    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    expect(agent.state.model.id).toBe('claude-sonnet-4-6')
    expect(agent.state.model.provider).toBe('anthropic')
  })

  it('agent starts with empty messages', async () => {
    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    expect(agent.state.messages).toEqual([])
  })

  it('agent has subscribe method for events', async () => {
    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent = getAgent()

    expect(typeof agent.subscribe).toBe('function')
  })

  it('getAgent returns the same instance on repeated calls', async () => {
    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent1 = getAgent()
    const agent2 = getAgent()

    expect(agent1).toBe(agent2)
  })

  it('resetAgent causes next getAgent to return a new instance', async () => {
    const { getAgent, resetAgent } = await import('../agent/agent')
    resetAgent()
    const agent1 = getAgent()
    resetAgent()
    const agent2 = getAgent()

    expect(agent1).not.toBe(agent2)
  })
})

describe('agent: guided checkpoint prompt', () => {
  it('system prompt contains guided print flow instructions', async () => {
    const { SYSTEM_PROMPT } = await import('../agent/context')

    expect(SYSTEM_PROMPT).toContain('Guided Print Flow')
    expect(SYSTEM_PROMPT).toContain('search_makerworld')
    expect(SYSTEM_PROMPT).toContain('download_model')
    expect(SYSTEM_PROMPT).toContain('slice_model')
    expect(SYSTEM_PROMPT).toContain('start_print')
    expect(SYSTEM_PROMPT).toContain('Never skip confirmation steps')
  })

  it('system prompt lists all tool capabilities', async () => {
    const { SYSTEM_PROMPT } = await import('../agent/context')

    expect(SYSTEM_PROMPT).toContain('Download models from MakerWorld')
    expect(SYSTEM_PROMPT).toContain('Start prints on the connected printer')
  })
})

describe('agent: dynamic context with queue section', () => {
  beforeEach(async () => {
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useWorkspaceStore, WORKSPACE_DEFAULT_STATE } = await import('../stores/workspace')
    const { usePrintHistoryStore, HISTORY_DEFAULT_STATE } = await import('../stores/printHistory')
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useWorkspaceStore.setState(WORKSPACE_DEFAULT_STATE)
    usePrintHistoryStore.setState(HISTORY_DEFAULT_STATE)
    // Clear any mock queue
    delete (globalThis as any).__MATERIALIZE_QUEUE__
  })

  it('includes Print Queue section in context output', async () => {
    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Print Queue')
    expect(ctx).toContain('(empty)')
  })

  it('shows queue items when __MATERIALIZE_QUEUE__ is set', async () => {
    ;(globalThis as any).__MATERIALIZE_QUEUE__ = [
      { id: 'q1', modelName: 'Benchy', status: 'pending' },
      { id: 'q2', modelName: 'Hook', status: 'submitted' },
    ]

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Print Queue')
    expect(ctx).toContain('Benchy [pending]')
    expect(ctx).toContain('Hook [submitted]')
  })

  it('shows failure reason for failed queue items', async () => {
    ;(globalThis as any).__MATERIALIZE_QUEUE__ = [
      { id: 'q1', modelName: 'Benchy', status: 'failed', reason: 'FTPS timeout' },
    ]

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('Benchy [failed: FTPS timeout]')
  })
})

describe('agent: dynamic context with print history section', () => {
  beforeEach(async () => {
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useWorkspaceStore, WORKSPACE_DEFAULT_STATE } = await import('../stores/workspace')
    const { usePrintHistoryStore, HISTORY_DEFAULT_STATE } = await import('../stores/printHistory')
    const { useLibraryStore, LIBRARY_DEFAULT_STATE } = await import('../stores/libraryStore')
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useWorkspaceStore.setState(WORKSPACE_DEFAULT_STATE)
    usePrintHistoryStore.setState(HISTORY_DEFAULT_STATE)
    useLibraryStore.setState(LIBRARY_DEFAULT_STATE)
    delete (globalThis as any).__MATERIALIZE_QUEUE__
  })

  it('includes "## Print History" section with (no history) when empty', async () => {
    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Print History')
    expect(ctx).toContain('(no history)')
  })

  it('shows recent records when history store has entries', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')
    const { act } = await import('@testing-library/react')

    act(() => {
      usePrintHistoryStore.getState().applySnapshot([
        {
          id: 'ph-1',
          modelName: 'Benchy',
          gcodeFile: null,
          startedAt: null,
          completedAt: '2026-03-15T09:00:00Z',
          durationSeconds: 3600,
          status: 'completed',
          failReason: null,
          filamentGrams: 12.5,
          filamentMeters: null,
          thumbnailPath: null,
          qualityProfile: null,
        },
        {
          id: 'ph-2',
          modelName: 'Hook',
          gcodeFile: null,
          startedAt: null,
          completedAt: '2026-03-14T14:00:00Z',
          durationSeconds: 900,
          status: 'failed',
          failReason: 'clog',
          filamentGrams: null,
          filamentMeters: null,
          thumbnailPath: null,
          qualityProfile: null,
        },
      ])
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Print History')
    expect(ctx).toContain('Benchy: completed (1h, 12.5g)')
    expect(ctx).toContain('Hook: failed (15m, ?)')
    expect(ctx).not.toContain('(no history)')
  })
})

describe('agent: dynamic context with library section', () => {
  beforeEach(async () => {
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useWorkspaceStore, WORKSPACE_DEFAULT_STATE } = await import('../stores/workspace')
    const { usePrintHistoryStore, HISTORY_DEFAULT_STATE } = await import('../stores/printHistory')
    const { useLibraryStore, LIBRARY_DEFAULT_STATE } = await import('../stores/libraryStore')
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useWorkspaceStore.setState(WORKSPACE_DEFAULT_STATE)
    usePrintHistoryStore.setState(HISTORY_DEFAULT_STATE)
    useLibraryStore.setState(LIBRARY_DEFAULT_STATE)
    delete (globalThis as any).__MATERIALIZE_QUEUE__
  })

  it('includes "## Model Library" section with (no models) when empty', async () => {
    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Model Library')
    expect(ctx).toContain('(no models)')
  })

  it('shows recent models when library store has entries', async () => {
    const { useLibraryStore } = await import('../stores/libraryStore')
    const { act } = await import('@testing-library/react')

    act(() => {
      useLibraryStore.getState().applySnapshot([
        {
          id: 'lib-1',
          modelName: 'Headphone Hook',
          author: 'DesignMaster',
          sourceUrl: 'https://makerworld.com/model/123',
          importedAt: '2026-03-15T08:00:00Z',
          thumbnailUrl: null,
          filePath: null,
          folderPath: '/tmp/hook',
          rating: null,
          downloadCount: null,
          fileCount: null,
        },
        {
          id: 'lib-2',
          modelName: 'Cable Clip',
          author: null,
          sourceUrl: null,
          importedAt: '2026-03-14T10:00:00Z',
          thumbnailUrl: null,
          filePath: null,
          folderPath: '/tmp/clip',
          rating: null,
          downloadCount: null,
          fileCount: null,
        },
      ])
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## Model Library')
    expect(ctx).toContain('2 models in library')
    expect(ctx).toContain('Headphone Hook (https://makerworld.com/model/123)')
    expect(ctx).toContain('Cable Clip')
    expect(ctx).not.toContain('(no models)')
  })
})

describe('agent: OpenSCAD design guidelines in context', () => {
  beforeEach(async () => {
    const { usePrinterStore, PRINTER_DEFAULT_STATE } = await import('../stores/printer')
    const { useWorkspaceStore, WORKSPACE_DEFAULT_STATE } = await import('../stores/workspace')
    const { usePrintHistoryStore, HISTORY_DEFAULT_STATE } = await import('../stores/printHistory')
    const { useLibraryStore, LIBRARY_DEFAULT_STATE } = await import('../stores/libraryStore')
    const { useOpenScadStore, OPENSCAD_DEFAULT_STATE } = await import('../stores/openscadStore')
    usePrinterStore.setState(PRINTER_DEFAULT_STATE)
    useWorkspaceStore.setState(WORKSPACE_DEFAULT_STATE)
    usePrintHistoryStore.setState(HISTORY_DEFAULT_STATE)
    useLibraryStore.setState(LIBRARY_DEFAULT_STATE)
    useOpenScadStore.setState(OPENSCAD_DEFAULT_STATE)
    delete (globalThis as any).__MATERIALIZE_QUEUE__
  })

  it('includes design guidelines when openscad store has loadedFile', async () => {
    const { useOpenScadStore } = await import('../stores/openscadStore')

    act(() => {
      useOpenScadStore.getState().applySnapshot({
        loadedFile: '/tmp/designs/cable-clip.scad',
        parameters: [],
        renderStatus: 'idle',
        lastStlPath: null,
        lastError: null,
      })
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## OpenSCAD Design Guidelines')
    expect(ctx).toContain('$fn')
    expect(ctx).toContain('module main()')
    expect(ctx).toContain('1.2mm')
    expect(ctx).toContain('modify_scad')
  })

  it('includes design guidelines when workspace view is scad', async () => {
    const { useWorkspaceStore } = await import('../stores/workspace')

    act(() => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        activeView: 'scad',
      })
    })

    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).toContain('## OpenSCAD Design Guidelines')
    expect(ctx).toContain('$fn')
  })

  it('excludes design guidelines when no design context is active', async () => {
    const { buildDynamicContext } = await import('../agent/context')
    const ctx = buildDynamicContext()

    expect(ctx).not.toContain('## OpenSCAD Design Guidelines')
    expect(ctx).not.toContain('module main()')
  })

  it('exports OPENSCAD_DESIGN_GUIDELINES constant', async () => {
    const { OPENSCAD_DESIGN_GUIDELINES } = await import('../agent/context')

    expect(OPENSCAD_DESIGN_GUIDELINES).toContain('$fn')
    expect(OPENSCAD_DESIGN_GUIDELINES).toContain('module main()')
    expect(OPENSCAD_DESIGN_GUIDELINES).toContain('0.01mm')
    expect(OPENSCAD_DESIGN_GUIDELINES).toContain('1.2mm')
    expect(OPENSCAD_DESIGN_GUIDELINES).toContain('Retry behavior')
    expect(OPENSCAD_DESIGN_GUIDELINES).toContain('Visual validation')
  })
})
