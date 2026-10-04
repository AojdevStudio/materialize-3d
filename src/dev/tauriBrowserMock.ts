import type { Channel } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import type { PrinterSnapshot } from '../stores/printer'
import type { WorkspaceSnapshot } from '../stores/workspace'
import type { PrinterConfig } from '../stores/printerConfigs'
import type { PartRevision, Revision, SignRevision } from '../types/designs'
import type { BuildResult } from '../types/generated'
import type { AgentEvent, AgentStatus, BuildStep, HistoryEntry, Provider } from '../types/agent'

interface MockAppStateSnapshot {
  printer: PrinterSnapshot
  workspace: WorkspaceSnapshot
  selectedPrinterId: string | null
}

// In-memory credential store for browser mock (replaces the OS credential store)
const mockCredentialStore = new Map<string, string>()
// In-memory print queue for browser mock
interface MockQueuedJob {
  id: string
  modelPath: string
  threemfPath: string
  modelName: string
  createdAt: string
  status: string
  reason?: string
}
const mockPrintQueue: MockQueuedJob[] = []
let mockQueueCounter = 0

// In-memory printer config store for browser mock
const mockPrinterConfigs: PrinterConfig[] = []
let mockConfigCounter = 0
let mockSelectedPrinterId: string | null = null

// In-memory settings store for browser mock (mirrors SETTING_DEFAULTS from backend)
const mockSettingsStore: Record<string, string> = {
  'default.quality': '0.20mm',
  'default.filament': 'Bambu PLA Basic',
  'notifications.print_complete': 'true',
  'notifications.print_failed': 'true',
  'notifications.filament_low': 'false',
  'connection.auto_connect': 'false',
}

const mockState: MockAppStateSnapshot = {
  printer: {
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
    cameraState: { status: 'unavailable', url: null, diagnostic: null },
    printerIp: null,
  },
  workspace: {
    activeModel: null,
    activeView: 'preview',
    makerworld: {
      currentUrl: 'https://makerworld.com/en',
      pageKind: 'home',
      detectedModel: null,
      importStatus: 'idle',
      importedFiles: [],
      lastExtractionError: null,
    },
  },
  selectedPrinterId: null,
}

function sampleModel(url: string) {
  return {
    id: '1073764',
    title: 'Simple Headphone Hook',
    author: 'AOJDevStudio',
    sourceUrl: url,
    rating: 4.8,
    reviewCount: 12,
    downloadCount: 341,
    images: ['https://makerworld.com/image.jpg'],
    files: [{ name: 'headphone-hook.3mf', fileType: '3MF', downloadUrl: null }],
  }
}

// One verified sign revision so the Signs view renders in a plain browser.
const MOCK_SIGN_PACKAGE_SHA = 'abc123f09e2d7b41c8a5e6f2d3b4c5a6e7f8091a2b3c4d5e6f708192a3b4c4e7'
let mockSign: SignRevision = {
  id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  lineage_id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
  number: 1,
  parent_id: null,
  kind: 'sign',
  title: 'Back Shortly',
  spec: {
    schema_version: 1,
    title: 'Back Shortly',
    width_mm: 150,
    height_mm: 210,
    thickness_mm: 2.6,
    base: { name: 'white', hex: '#FFFFFF' },
    inks: [
      { name: 'navy', hex: '#1F3A5F' },
      { name: 'teal', hex: '#1A9E96' },
    ],
    elements: [],
  },
  spec_sha256: '5e'.repeat(32),
  build_id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  build_key: 'b4'.repeat(32),
  requested_by: 'agent',
  build: {
    status: 'verified',
    artifacts: {
      revision_dir: '/mock/signs/rev1',
      package_path: '/mock/signs/rev1/sign.3mf',
      package_sha256: MOCK_SIGN_PACKAGE_SHA,
      preview_path: '/mock/signs/rev1/preview.png',
      slice_dir: '/mock/signs/rev1/slice',
      gcode_sha256: '7f3a91c2e4d5b6a7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d0d1b',
      slicer: { name: 'Bambu Studio', version: '02.08.02.61', profile_version: '02.00.00.52' },
      effective_settings: {
        printer_settings_id: 'Bambu Lab P2S 0.4 nozzle',
        print_settings_id: '0.20mm Standard @BBL P2S',
        filament_settings_id: ['Bambu PLA Basic @BBL P2S', 'Bambu PLA Basic @BBL P2S', 'Bambu PLA Basic @BBL P2S'],
        filament_colour: ['#FFFFFF', '#1F3A5F', '#1A9E96'],
        nozzle_diameter: ['0.4', '0.4', '0.4'],
        printable_area: ['0x0', '256x0', '256x256', '0x256'],
        layer_height: '0.2',
        enable_prime_tower: true,
        start_gcode_matches_preset: true,
        start_gcode_in_gcode_header: true,
      },
      checks: [
        ...['base', 'navy', 'teal'].flatMap((body) =>
          ['closed_manifold', 'non_degenerate', 'outward_orientation'].map((name) => ({
            id: `geometry.${name}.${body}`,
            passed: true,
            advisory: false,
            detail: 'ok',
          })),
        ),
        { id: 'geometry.bounds.sign', passed: true, advisory: false, detail: '150.00 x 210.00 x 2.60 mm' },
        { id: 'slice.slice_succeeded', passed: true, advisory: false, detail: 'exit 0, return_code 0, 1 plate(s)' },
        { id: 'slice.no_warnings', passed: true, advisory: false, detail: 'no plate warnings' },
        { id: 'slice.placement_preserved', passed: true, advisory: false, detail: 'max deviation 0.48 mm of 1.00 mm' },
        {
          id: 'handoff.settings_match_slice',
          passed: true,
          advisory: false,
          detail: 'package settings and colors match the verified slice',
        },
      ],
    },
  },
  approval: { status: 'pending' },
  print_validation: { status: 'not_tested' },
  created_at: '2026-09-25T14:10:00Z',
  updated_at: '2026-09-25T14:12:00Z',
}

// One verified part revision, the cable clip's repair, so the Designs view
// shows a part (its view arrives with pr8-gui). Dev-only, like everything here.
const MOCK_PART_CLIP_SOURCE = 'from build123d import *\nfrom materialize import Body\n\ndef build(p): ...'
const mockPart: PartRevision = {
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
  lineage_id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  number: 2,
  parent_id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  kind: 'part',
  title: 'Six USB-C desk clip',
  spec: {
    schema_version: 1,
    title: 'Six USB-C desk clip',
    source: MOCK_PART_CLIP_SOURCE,
    params: { cables: 6, cable_d: 4, clearance: 0.4, desk_t: 18, span: 60, depth: 25, wall: 3, fillet: 1.2 },
    requirements: [{ measure: 'span', name: 'width', axis: 'x', mm: 60, tol: 0.2 }],
    filaments: [{ slot: 1, name: 'Black' }],
  },
  spec_sha256: '3c'.repeat(32),
  build_id: '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
  build_key: 'd7'.repeat(32),
  requested_by: 'agent',
  build: {
    status: 'verified',
    artifacts: {
      ...mockSign.build.status === 'verified' ? mockSign.build.artifacts : ({} as never),
      revision_dir: '/mock/signs/4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a',
      package_path: '/mock/signs/4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a/part.3mf',
      package_sha256: 'e1'.repeat(32),
      preview_path: '/mock/signs/4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a/preview.png',
      // The part plan for one body and one requirement, in recorded order:
      // 14 blocking checks, and 4 advisory ones of which the overhang failed.
      checks: [
        ...['closed_manifold', 'non_degenerate', 'outward_orientation', 'bounds'].map((name) => ({
          id: `geometry.${name}.clip`,
          passed: true,
          advisory: false,
          detail: 'ok',
        })),
        { id: 'geometry.requirement.0', passed: true, advisory: false, detail: 'width 60.02 mm (60 ± 0.2)' },
        { id: 'print.overhang.clip', passed: false, advisory: true, detail: 'about 1218 mm² unsupported at z 21.4 mm' },
        { id: 'print.min_wall.clip', passed: true, advisory: true, detail: 'no wall narrower than 0.4 mm' },
        { id: 'print.first_layer.clip', passed: true, advisory: true, detail: 'touches the bed over 1500 mm²' },
        ...[
          'slice_succeeded',
          'no_warnings',
          'presets_applied',
          'start_gcode_intact',
          'input_unchanged',
          'filaments_preserved',
          'placement_preserved',
          'layer1_coverage',
        ].map((name) => ({ id: `slice.${name}`, passed: true, advisory: false, detail: 'ok' })),
        {
          id: 'handoff.settings_match_slice',
          passed: true,
          advisory: false,
          detail: 'package settings and colors match the verified slice',
        },
        { id: 'slice.support_warning', passed: true, advisory: true, detail: 'Bambu Studio raised no support warning' },
      ],
    },
  },
  approval: { status: 'pending' },
  print_validation: { status: 'not_tested' },
  created_at: '2026-10-04T14:10:00Z',
  updated_at: '2026-10-04T14:12:00Z',
}

// The clip's first build, which failed at generate before its repair.
const mockFailedPart: PartRevision = {
  ...mockPart,
  id: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  number: 1,
  parent_id: null,
  spec: { ...mockPart.spec, params: { ...mockPart.spec.params, fillet: 99 } },
  build_id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  build: {
    status: 'failed',
    reason: 'generate: line 10: ValueError: Failed creating a fillet with radius of 99, try a smaller value',
    artifacts: null,
  },
}

// The part revisions the scripted turn has made so far: none until it runs.
let mockPartsMade: PartRevision[] = []

const mockRevisions = (): Revision[] => [...mockPartsMade.map((part) => structuredClone(part)), structuredClone(mockSign)]

/** Draws a stand-in finished face and returns PNG bytes, like `design_preview`. */
async function mockSignPreview(): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(600, 840)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('mock preview: no 2d context')
  context.fillStyle = '#FFFFFF'
  context.fillRect(0, 0, 600, 840)
  context.fillStyle = '#1A9E96'
  context.fillRect(80, 360, 440, 10)
  context.fillStyle = '#1F3A5F'
  context.font = '900 52px sans-serif'
  context.textAlign = 'center'
  context.fillText('BACK SHORTLY', 300, 320)
  context.fillRect(80, 600, 440, 136)
  context.fillStyle = '#FFFFFF'
  context.fillText('THANK YOU', 300, 690)
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
}

async function updateMockSign(next: Partial<SignRevision>): Promise<SignRevision> {
  mockSign = { ...mockSign, ...next, updated_at: new Date().toISOString() }
  await emit('designs:changed', mockSign.id)
  return structuredClone(mockSign)
}

async function emitWorkspace() {
  await emit('workspace:changed', structuredClone(mockState.workspace))
}

export function installTauriBrowserMock() {
  if (typeof window === 'undefined' || '__TAURI_INTERNALS__' in window) {
    return
  }

  mockWindows('main')
  mockIPC(async (cmd, payload) => {
    if (cmd === 'get_app_state') {
      return structuredClone(mockState)
    }

    if (cmd === 'sync_makerworld_webview') {
      return {}
    }

    if (cmd === 'navigate_makerworld') {
      const nextArgs = payload as { url: string }
      const url = nextArgs.url.startsWith('http') ? nextArgs.url : `https://${nextArgs.url}`
      const isModel = url.includes('/models/')
      mockState.workspace = {
        ...mockState.workspace,
        activeView: 'browser',
        makerworld: {
          ...mockState.workspace.makerworld,
          currentUrl: url,
          pageKind: isModel ? 'model' : url.includes('/search/') ? 'search' : 'other',
          detectedModel: isModel ? sampleModel(url) : null,
          importStatus: isModel ? 'ready' : 'idle',
          lastExtractionError: null,
        },
      }
      await emitWorkspace()
      return structuredClone(mockState)
    }

    if (cmd === 'search_makerworld') {
      const nextArgs = payload as { query: string }
      const url = `https://makerworld.com/en/search/models?keyword=${encodeURIComponent(nextArgs.query)}`
      mockState.workspace = {
        ...mockState.workspace,
        activeView: 'browser',
        makerworld: {
          ...mockState.workspace.makerworld,
          currentUrl: url,
          pageKind: 'search',
          detectedModel: null,
          importStatus: 'idle',
          lastExtractionError: null,
        },
      }
      await emitWorkspace()
      return structuredClone(mockState)
    }

    if (cmd === 'makerworld_back' || cmd === 'makerworld_forward' || cmd === 'makerworld_reload') {
      return structuredClone(mockState)
    }

    if (cmd === 'download_model') {
      mockState.workspace = {
        ...mockState.workspace,
        makerworld: {
          ...mockState.workspace.makerworld,
          importStatus: 'downloading',
        },
      }
      await emitWorkspace()

      setTimeout(async () => {
        mockState.workspace = {
          ...mockState.workspace,
          activeModel: {
            id: mockState.workspace.makerworld.detectedModel?.id ?? '1073764',
            name: mockState.workspace.makerworld.detectedModel?.title ?? 'Simple Headphone Hook',
            path: '/tmp/materialize-3d/library/makerworld/simple-headphone-hook/headphone-hook.3mf',
            source: mockState.workspace.makerworld.currentUrl,
            sizeBytes: 2400000,
          },
          makerworld: {
            ...mockState.workspace.makerworld,
            importStatus: 'imported',
            importedFiles: ['/tmp/materialize-3d/library/makerworld/simple-headphone-hook/headphone-hook.3mf'],
            lastExtractionError: null,
          },
        }
        await emitWorkspace()
      }, 600)

      return {
        importStatus: 'downloading',
        importedFiles: structuredClone(mockState.workspace.makerworld.importedFiles),
      }
    }

    if (cmd === 'connect_printer') {
      mockState.printer = {
        ...mockState.printer,
        connectionState: 'discovering',
      }
      await emit('printer:changed', structuredClone(mockState.printer))

      setTimeout(async () => {
        mockState.printer = {
          ...mockState.printer,
          isConnected: true,
          connectionState: 'connected_mqtt',
          connectionType: 'mqtt',
          name: 'AOJDevStudio',
          nozzleTemp: 25.3,
          nozzleTargetTemp: 0,
          bedTemp: 23.1,
          bedTargetTemp: 0,
          chamberTemp: 22.5,
          gcodeState: 'IDLE',
          printProgress: null,
          remainingTime: null,
          lastError: null,
        }
        await emit('printer:changed', structuredClone(mockState.printer))
      }, 1500)

      return {}
    }

    if (cmd === 'disconnect_printer') {
      mockState.printer = {
        ...mockState.printer,
        isConnected: false,
        connectionState: 'disconnected',
        connectionType: null,
        gcodeState: null,
      }
      await emit('printer:changed', structuredClone(mockState.printer))
      return {}
    }

    if (cmd === 'get_printer_status') {
      return structuredClone(mockState.printer)
    }

    if (cmd === 'set_active_view') {
      const nextArgs = payload as { view: WorkspaceSnapshot['activeView'] }

      mockState.workspace = {
        ...mockState.workspace,
        activeView: nextArgs.view,
      }

      await emitWorkspace()
      return structuredClone(mockState)
    }

    if (cmd === 'read_model_file') {
      // Return empty bytes in browser mock — no real file system
      return []
    }

    if (cmd === 'list_profiles') {
      console.debug('mock:ipc', cmd)
      return {
        qualities: ['0.08mm', '0.12mm', '0.16mm', '0.20mm', '0.28mm'],
        filaments: ['Bambu PLA Basic', 'Bambu PLA Matte', 'Bambu PETG Basic', 'Bambu ABS', 'Generic PLA', 'Generic PETG'],
      }
    }

    if (cmd === 'slice_model') {
      console.debug('mock:ipc', cmd, payload)
      return {
        success: true,
        gcodeFile: '/tmp/materialize-3d/output/model_sliced.gcode',
        estimatedTime: 2700, // 45 minutes in seconds
        filamentUsed: 12.4, // grams
        layerCount: 180,
        warnings: [],
      }
    }

    if (cmd === 'start_print') {
      console.debug('mock:ipc', cmd, payload)
      const args = payload as { path: string }
      const filename = args.path.split('/').pop() ?? 'model.3mf'
      return {
        success: true,
        filename,
        md5: 'abc123def456789012345678abcdef00',
        error: null,
      }
    }

    if (cmd === 'add_to_queue') {
      const args = payload as { modelPath: string; threemfPath: string; modelName: string }
      mockQueueCounter++
      const job: MockQueuedJob = {
        id: `mock-q-${mockQueueCounter}`,
        modelPath: args.modelPath,
        threemfPath: args.threemfPath,
        modelName: args.modelName,
        createdAt: new Date().toISOString(),
        status: 'pending',
      }
      mockPrintQueue.push(job)
      // Expose queue for agent context
      ;(window as any).__MATERIALIZE_QUEUE__ = structuredClone(mockPrintQueue)
      return structuredClone(job)
    }

    if (cmd === 'get_queue') {
      return structuredClone(mockPrintQueue)
    }

    if (cmd === 'remove_from_queue') {
      const args = payload as { jobId: string }
      const idx = mockPrintQueue.findIndex((j) => j.id === args.jobId)
      if (idx !== -1) {
        mockPrintQueue.splice(idx, 1)
        ;(window as any).__MATERIALIZE_QUEUE__ = structuredClone(mockPrintQueue)
        return true
      }
      return false
    }

    // ── Agent mock handlers: a scripted Rust agent ──

    const agentResult = handleAgentCommand(cmd, payload)
    if (agentResult !== NOT_AGENT) return agentResult

    // ── Printer config mock handlers (T03) ──

    if (cmd === 'get_printer_configs') {
      return structuredClone(mockPrinterConfigs)
    }

    if (cmd === 'add_printer_config') {
      const args = payload as { name: string; host: string; serial: string; accessCode: string }
      mockConfigCounter++
      const now = new Date().toISOString()
      const config: PrinterConfig = {
        id: `mock-pc-${mockConfigCounter}`,
        name: args.name,
        host: args.host,
        serial: args.serial,
        isDefault: mockPrinterConfigs.length === 0,
        createdAt: now,
        updatedAt: now,
      }
      mockPrinterConfigs.push(config)
      // Store access code in mock credential store
      mockCredentialStore.set(`printer:${config.id}:access_code`, args.accessCode)
      await emit('printer-configs:changed', structuredClone(mockPrinterConfigs))
      return structuredClone(config)
    }

    if (cmd === 'delete_printer_config') {
      const args = payload as { id: string }
      const idx = mockPrinterConfigs.findIndex((c) => c.id === args.id)
      if (idx === -1) throw new Error(`printer config ${args.id} not found`)
      mockPrinterConfigs.splice(idx, 1)
      mockCredentialStore.delete(`printer:${args.id}:access_code`)
      if (mockSelectedPrinterId === args.id) {
        mockSelectedPrinterId = null
        mockState.selectedPrinterId = null
      }
      await emit('printer-configs:changed', structuredClone(mockPrinterConfigs))
      return true
    }

    if (cmd === 'set_default_printer') {
      const args = payload as { id: string }
      const target = mockPrinterConfigs.find((c) => c.id === args.id)
      if (!target) throw new Error(`printer config ${args.id} not found`)
      for (const c of mockPrinterConfigs) c.isDefault = false
      target.isDefault = true
      await emit('printer-configs:changed', structuredClone(mockPrinterConfigs))
      return structuredClone(target)
    }

    if (cmd === 'connect_printer_by_config') {
      const args = payload as { id: string }
      const config = mockPrinterConfigs.find((c) => c.id === args.id)
      if (!config) throw new Error(`printer config ${args.id} not found`)
      mockSelectedPrinterId = args.id
      mockState.selectedPrinterId = args.id
      mockState.printer = {
        ...mockState.printer,
        connectionState: 'discovering',
        name: config.name,
      }
      await emit('printer:changed', structuredClone(mockState.printer))

      setTimeout(async () => {
        mockState.printer = {
          ...mockState.printer,
          isConnected: true,
          connectionState: 'connected_mqtt',
          connectionType: 'mqtt',
          nozzleTemp: 25.3,
          nozzleTargetTemp: 0,
          bedTemp: 23.1,
          bedTargetTemp: 0,
          chamberTemp: 22.5,
          gcodeState: 'IDLE',
          printProgress: null,
          remainingTime: null,
          lastError: null,
        }
        await emit('printer:changed', structuredClone(mockState.printer))
      }, 1000)

      return {}
    }

    if (cmd === 'switch_printer') {
      const args = payload as { id: string }
      const config = mockPrinterConfigs.find((c) => c.id === args.id)
      if (!config) throw new Error(`printer config ${args.id} not found`)

      // Disconnect current
      if (mockState.printer.isConnected) {
        mockState.printer = {
          ...mockState.printer,
          isConnected: false,
          connectionState: 'disconnected',
          connectionType: null,
          gcodeState: null,
        }
        await emit('printer:changed', structuredClone(mockState.printer))
      }

      // Connect new
      mockSelectedPrinterId = args.id
      mockState.selectedPrinterId = args.id
      mockState.printer = {
        ...mockState.printer,
        connectionState: 'discovering',
        name: config.name,
      }
      await emit('printer:changed', structuredClone(mockState.printer))

      setTimeout(async () => {
        mockState.printer = {
          ...mockState.printer,
          isConnected: true,
          connectionState: 'connected_mqtt',
          connectionType: 'mqtt',
          nozzleTemp: 25.3,
          nozzleTargetTemp: 0,
          bedTemp: 23.1,
          bedTargetTemp: 0,
          chamberTemp: 22.5,
          gcodeState: 'IDLE',
          printProgress: null,
          remainingTime: null,
          lastError: null,
        }
        await emit('printer:changed', structuredClone(mockState.printer))
      }, 1000)

      return {}
    }

    // ── Settings mock handlers (S02/T02) ──

    if (cmd === 'get_settings') {
      console.debug('mock:ipc', cmd)
      return structuredClone(mockSettingsStore)
    }

    if (cmd === 'update_settings') {
      const args = payload as { settings: Record<string, string> }
      console.debug('mock:ipc', cmd, args.settings)
      Object.assign(mockSettingsStore, args.settings)
      await emit('settings:changed', structuredClone(mockSettingsStore))
      return undefined
    }

    if (cmd === 'design_list') {
      return mockRevisions()
    }

    if (cmd === 'design_lineage') {
      const { lineageId } = payload as { lineageId: string }
      return mockRevisions().filter((revision) => revision.lineage_id === lineageId)
    }

    if (cmd === 'design_get') {
      const { id } = payload as { id: string }
      return mockRevisions().find((revision) => revision.id === id) ?? structuredClone(mockSign)
    }

    if (cmd === 'design_preview') {
      return mockSignPreview()
    }

    if (cmd === 'design_approve') {
      const args = payload as { id: string; packageSha256: string; acknowledgedWarnings: string[] }
      if (args.packageSha256 !== MOCK_SIGN_PACKAGE_SHA) {
        throw `package hash mismatch: expected ${args.packageSha256}, found ${MOCK_SIGN_PACKAGE_SHA}`
      }
      return updateMockSign({
        approval: {
          status: 'approved',
          package_sha256: MOCK_SIGN_PACKAGE_SHA,
          acknowledged_warnings: args.acknowledgedWarnings,
          at: new Date().toISOString(),
        },
      })
    }

    if (cmd === 'design_export') {
      return (payload as { destination: string }).destination
    }

    if (cmd === 'design_record_print') {
      const args = payload as { passed: boolean; note: string }
      const at = new Date().toISOString()
      return updateMockSign({
        print_validation: args.passed ? { status: 'passed', at, note: args.note } : { status: 'failed', at, note: args.note },
      })
    }

    if (cmd === 'read_text_file') {
      return JSON.stringify(mockSign.spec)
    }

    if (cmd === 'design_build') {
      return { revision: structuredClone(mockSign), reused: true }
    }

    if (cmd === 'design_cancel') {
      return false
    }

    throw new Error(`Unhandled mock IPC command: ${cmd}`)
  }, { shouldMockEvents: true })
}

// ── Scripted agent ──
//
// Mirrors the Rust agent's commands closely enough for `bun run dev` in a
// browser: a prompt about the printer runs printer_status; a prompt about a
// part or clip runs a part build that fails at generate and its repair;
// anything else runs a sign build with one step every STEP_MS. Clear the key
// in Settings to see the missing-key error.

const NOT_AGENT = Symbol('not an agent command')
const STEP_MS = 1500
const BUILD_STEPS: BuildStep[] = ['spec_validated', 'geometry_built', 'package_written', 'sliced', 'verified']

const mockAgent = {
  status: { provider: 'anthropic', model: 'claude-sonnet-5', hasApiKey: true } as AgentStatus,
  keys: new Set<Provider>(['anthropic']),
  conversationId: 'mock-conversation-1',
  conversationCount: 1,
  history: [] as HistoryEntry[],
  cancelled: new Set<string>(),
  revision: 1,
}

const agentStatus = (): AgentStatus => ({ ...mockAgent.status, hasApiKey: mockAgent.keys.has(mockAgent.status.provider) })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function handleAgentCommand(cmd: string, payload: unknown): unknown {
  const args = (payload ?? {}) as Record<string, unknown>
  switch (cmd) {
    case 'agent_status':
      return agentStatus()
    case 'agent_set_api_key':
      mockAgent.keys.add(args.provider as Provider)
      return agentStatus()
    case 'agent_clear_api_key':
      mockAgent.keys.delete(args.provider as Provider)
      return agentStatus()
    case 'agent_set_model':
      mockAgent.status = { ...mockAgent.status, provider: args.provider as Provider, model: args.model as string }
      return agentStatus()
    case 'agent_history':
      return { conversationId: mockAgent.conversationId, entries: structuredClone(mockAgent.history) }
    case 'agent_new_conversation':
      mockAgent.conversationCount += 1
      mockAgent.conversationId = `mock-conversation-${mockAgent.conversationCount}`
      mockAgent.history = []
      return { conversationId: mockAgent.conversationId }
    case 'agent_cancel':
      mockAgent.cancelled.add(args.turnId as string)
      return true
    case 'agent_send':
      return runMockTurn(args.turnId as string, args.text as string, args.onEvent as Channel<AgentEvent>)
    default:
      return NOT_AGENT
  }
}

// Replays a turn with the AgentEvent protocol from src/types/agent.ts, which
// mirrors src-tauri/src/agent/protocol.rs. Update this when either changes.
async function runMockTurn(turnId: string, text: string, channel: Channel<AgentEvent>): Promise<void> {
  const send = (event: AgentEvent) => channel.onmessage(event)
  const now = () => new Date().toISOString()
  const cancelled = () => mockAgent.cancelled.has(turnId)
  const say = async (reply: string) => {
    for (const word of reply.split(/(?<= )/)) {
      send({ type: 'textDelta', text: word })
      await sleep(30)
    }
    mockAgent.history.push({ role: 'assistant', id: crypto.randomUUID(), text: reply, createdAt: now() })
  }

  mockAgent.history.push({ role: 'user', id: crypto.randomUUID(), text, createdAt: now() })
  send({ type: 'turnStarted', conversationId: mockAgent.conversationId, turnId })
  await sleep(300)

  const status = agentStatus()
  if (!status.hasApiKey) {
    const name = status.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
    send({ type: 'error', kind: 'missingApiKey', message: `${name} API key is missing. The request was not sent.` })
    return
  }

  if (/printer|status/i.test(text)) {
    const callId = crypto.randomUUID()
    send({ type: 'toolCall', callId, name: 'printer_status', args: {} })
    await sleep(600)
    const output = { connection: mockState.printer.connectionState, name: mockState.printer.name }
    send({ type: 'toolResult', callId, ok: true, output })
    mockAgent.history.push({ role: 'tool', callId, name: 'printer_status', args: {}, status: 'completed', output, createdAt: now() })
    await say(mockState.printer.isConnected ? 'The printer is connected and idle.' : 'The printer is not connected right now.')
    send({ type: 'turnFinished' })
    return
  }

  if (/part|clip/i.test(text)) {
    await runMockPartTurn(send, say, cancelled, now)
    return
  }

  await say('Building a 150 x 210 x 2.6 mm sign: white PLA Basic base, navy and teal inlays.')
  const callId = crypto.randomUUID()
  const buildArgs = { kind: 'sign', spec: { title: 'Back Shortly door sign', width_mm: 150, height_mm: 210 } }
  send({ type: 'toolCall', callId, name: 'build', args: buildArgs })
  const record = (status: 'completed' | 'cancelled', output: unknown) =>
    mockAgent.history.push({ role: 'tool', callId, name: 'build', args: buildArgs, status, output, createdAt: now() })

  for (const step of BUILD_STEPS) {
    await sleep(STEP_MS)
    if (cancelled()) {
      record('cancelled', null)
      send({ type: 'turnCancelled' })
      return
    }
    send({ type: 'toolProgress', callId, step })
  }

  mockAgent.revision += 1
  const sign: BuildResult = {
    revision_id: `mock-rev-${mockAgent.revision}`,
    lineage_id: 'mock-lineage',
    kind: 'sign',
    number: mockAgent.revision,
    title: buildArgs.spec.title,
    build: 'verified',
    failure_reason: null,
    stage: null,
    checks_passed: 9,
    checks_total: 9,
    failed_checks: [],
    warnings: [],
    requirements: [],
    size_mm: [150, 210, 2.6],
    package_sha256: 'abc123f09d1e7b55c0a4e2f6781d3b9ac0ffee12de45f67a89b0c1d2e3f4c4e7',
    approval: 'pending',
    print_validation: 'not_tested',
    requested_by: 'agent',
    created_at: now(),
    reused: false,
    shown: true,
    views: ['face'],
    views_missing: [],
  }
  send({ type: 'toolResult', callId, ok: true, output: sign })
  record('completed', sign)
  await say(`Revision r${sign.number} passed all checks. Review and approve it in the Signs view.`)
  send({ type: 'turnFinished' })
}

/** A part summary like the Rust `BuildResult`, from the mock part revision. */
function mockPartResult(overrides: Partial<BuildResult>): BuildResult {
  return {
    revision_id: mockPart.id,
    lineage_id: mockPart.lineage_id,
    kind: 'part',
    number: mockPart.number,
    title: mockPart.title,
    build: 'verified',
    failure_reason: null,
    stage: null,
    checks_passed: 14,
    checks_total: 14,
    failed_checks: [],
    warnings: ['print.overhang.clip: about 1218 mm² unsupported at z 21.4 mm'],
    requirements: ['width 60.02 mm (60 ± 0.2)'],
    size_mm: [60, 25, 26.8],
    package_sha256: 'e1'.repeat(32),
    approval: 'pending',
    print_validation: 'not_tested',
    requested_by: 'agent',
    created_at: new Date().toISOString(),
    reused: false,
    shown: true,
    views: ['isometric', 'front', 'top'],
    views_missing: [],
    ...overrides,
  }
}

/** The design's repair loop, scripted: a fillet too large fails at generate, then the repair verifies. */
async function runMockPartTurn(
  send: (event: AgentEvent) => void,
  say: (reply: string) => Promise<void>,
  cancelled: () => boolean,
  now: () => string,
): Promise<void> {
  const builds = [
    {
      args: { kind: 'part', spec: { title: mockPart.title, params: { ...mockPart.spec.params, fillet: 99 } } },
      steps: ['spec_validated'] as BuildStep[],
      revision: mockFailedPart,
      result: mockPartResult({
        revision_id: mockFailedPart.id,
        number: 1,
        build: 'failed',
        stage: 'generate',
        failure_reason: 'generate: line 10: ValueError: Failed creating a fillet with radius of 99, try a smaller value',
        checks_passed: 0,
        checks_total: 0,
        warnings: [],
        requirements: [],
        size_mm: null,
        package_sha256: null,
        views: [],
      }),
      reply: 'The fillet radius was too large for the jaw edge. Fixing it and building again in the same design.',
    },
    {
      args: { kind: 'part', spec: { title: mockPart.title, params: mockPart.spec.params }, lineage_id: mockPart.lineage_id },
      steps: BUILD_STEPS,
      revision: mockPart,
      result: mockPartResult({}),
      reply: 'Revision r2 verified, 14 of 14 checks, with one overhang warning. It waits for your approval in the app.',
    },
  ]
  await say('Building a six-cable desk clip, 60 mm wide, for an 18 mm desk.')
  for (const build of builds) {
    const callId = crypto.randomUUID()
    send({ type: 'toolCall', callId, name: 'build', args: build.args })
    for (const step of build.steps) {
      await sleep(STEP_MS / 3)
      if (cancelled()) {
        send({ type: 'turnCancelled' })
        return
      }
      send({ type: 'toolProgress', callId, step })
    }
    // As the in-app agent's build does: the revision is recorded, then shown.
    mockPartsMade = [build.revision, ...mockPartsMade.filter((part) => part.id !== build.revision.id)]
    send({ type: 'toolResult', callId, ok: true, output: build.result })
    mockAgent.history.push({ role: 'tool', callId, name: 'build', args: build.args, status: 'completed', output: build.result, createdAt: now() })
    await emit('designs:changed', build.revision.id)
    await emit('designs:open', { revisionId: build.revision.id })
    await say(build.reply)
  }
  send({ type: 'turnFinished' })
}
