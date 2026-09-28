import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import type { PrinterSnapshot } from '../stores/printer'
import type { WorkspaceSnapshot } from '../stores/workspace'
import type { PrinterConfig } from '../stores/printerConfigs'
import type { ProactiveNotificationPayload } from '../agent/notifications'

interface MockAppStateSnapshot {
  printer: PrinterSnapshot
  workspace: WorkspaceSnapshot
  selectedPrinterId: string | null
}

// In-memory credential store for browser mock (replaces the OS credential store)
const mockCredentialStore = new Map<string, string>()
// Track active OAuth callback port for mock
let mockOAuthCallbackPort: number | null = null
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

    // ── Credential / OAuth mock handlers (T02) ──

    if (cmd === 'get_credential') {
      const args = payload as { key: string }
      return mockCredentialStore.get(args.key) ?? null
    }

    if (cmd === 'store_credential') {
      const args = payload as { key: string; value: string }
      mockCredentialStore.set(args.key, args.value)
      return undefined
    }

    if (cmd === 'delete_credential') {
      const args = payload as { key: string }
      const existed = mockCredentialStore.has(args.key)
      mockCredentialStore.delete(args.key)
      return existed
    }

    if (cmd === 'has_credential') {
      const args = payload as { key: string }
      return mockCredentialStore.has(args.key)
    }

    if (cmd === 'start_oauth_callback') {
      const args = payload as { port: number }
      mockOAuthCallbackPort = args.port
      // Simulate callback event after a short delay (browser dev mode)
      setTimeout(async () => {
        await emit('oauth:callback', {
          code: 'mock_auth_code_' + mockOAuthCallbackPort,
          state: 'mock_state',
        })
      }, 100)
      return undefined
    }

    if (cmd === 'stop_oauth_callback') {
      mockOAuthCallbackPort = null
      return undefined
    }

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

    throw new Error(`Unhandled mock IPC command: ${cmd}`)
  }, { shouldMockEvents: true })
}

/**
 * Emit a synthetic `proactive:notification` event for browser-mode testing.
 * Dispatches the same Tauri event shape the Rust backend would emit.
 *
 * Usage (browser console):
 *   emitProactiveNotification({ event_type: 'print_complete', model_name: 'Test Cube', printer_name: 'P2S' })
 */
export async function emitProactiveNotification(
  payload: ProactiveNotificationPayload
): Promise<void> {
  await emit('proactive:notification', payload)
}
