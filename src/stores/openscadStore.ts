import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import useTauriEvent from '../hooks/useTauriEvent'

// ─── Types (mirrors Rust ScadParameter & OpenScadSnapshot) ────────────────────

export interface ScadParameter {
  name: string
  type: string
  initial: number | string | boolean
  min?: number | null
  max?: number | null
  step?: number | null
  group?: string | null
  caption?: string | null
}

export type OpenScadRenderStatus =
  | 'idle'
  | 'extracting_params'
  | 'rendering'
  | 'error'

export interface OpenScadCompileError {
  line: number
  message: string
  fullStderr: string
}

export interface OpenScadRenderResult {
  stlPath: string
  stderrWarnings: string[]
  durationMs: number
}

export interface ScadParamResult {
  parameters: ScadParameter[]
  title?: string | null
}

/** Shape matches Rust OpenScadSnapshot exactly (camelCase via serde) */
export interface OpenScadSnapshot {
  loadedFile: string | null
  parameters: ScadParameter[]
  renderStatus: string
  lastStlPath: string | null
  lastError: OpenScadCompileError | null
}

// ─── Store State ──────────────────────────────────────────────────────────────

interface OpenScadState extends OpenScadSnapshot {
  // Actions
  loadFile: (path: string) => Promise<ScadParamResult>
  render: (paramOverrides?: Record<string, string>) => Promise<OpenScadRenderResult>
  updateParameter: (name: string, value: number | string | boolean) => void
  clearFile: () => void
  applySnapshot: (snapshot: OpenScadSnapshot) => void
}

export const OPENSCAD_DEFAULT_STATE: OpenScadSnapshot = {
  loadedFile: null,
  parameters: [],
  renderStatus: 'idle',
  lastStlPath: null,
  lastError: null,
}

// ─── Debounced Render Helper ──────────────────────────────────────────────────

let renderTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Schedule a debounced render (300ms). Cancels any pending timer.
 * Reads current store state for loadedFile and builds overrides from parameters.
 */
export function debouncedRender() {
  if (renderTimer) clearTimeout(renderTimer)
  renderTimer = setTimeout(() => {
    const state = useOpenScadStore.getState()
    if (!state.loadedFile) return

    const overrides: Record<string, string> = {}
    for (const p of state.parameters) {
      overrides[p.name] = String(p.initial)
    }

    console.debug('openscad:debounced-render', state.loadedFile)
    void state.render(overrides)
  }, 300)
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useOpenScadStore = create<OpenScadState>()(
  subscribeWithSelector((set, get) => ({
    ...OPENSCAD_DEFAULT_STATE,

    applySnapshot: (snapshot) => set(snapshot),

    loadFile: async (path) => {
      // Optimistic local state update; Rust command also emits events
      set({ loadedFile: path, renderStatus: 'extracting_params', lastError: null })

      const result = await invoke<ScadParamResult>('openscad_extract_params', { path })
      // State will be fully updated by the Tauri event, but return result for callers
      return result
    },

    render: async (paramOverrides) => {
      const { loadedFile } = get()
      if (!loadedFile) throw new Error('No file loaded')

      set({ renderStatus: 'rendering', lastError: null })

      const result = await invoke<OpenScadRenderResult>('openscad_render', {
        path: loadedFile,
        overrides: paramOverrides ?? null,
      })
      // State will be fully updated by the Tauri event
      return result
    },

    updateParameter: (name, value) => {
      set((state) => ({
        parameters: state.parameters.map((p) =>
          p.name === name ? { ...p, initial: value } : p,
        ),
      }))
    },

    clearFile: () => {
      if (renderTimer) clearTimeout(renderTimer)
      set({ ...OPENSCAD_DEFAULT_STATE })
    },
  })),
)

// ─── Event Bridge ─────────────────────────────────────────────────────────────

export function applyOpenScadSnapshot(snapshot: OpenScadSnapshot) {
  useOpenScadStore.getState().applySnapshot(snapshot)
}

/**
 * React hook — subscribe to `openscad:state-changed` Tauri events.
 * Mount this in the app shell alongside other event bridges.
 */
export function useOpenScadEvents() {
  useTauriEvent<OpenScadSnapshot>('openscad:state-changed', ({ payload }) => {
    console.debug('event received:', 'openscad:state-changed', payload)
    applyOpenScadSnapshot(payload)
  })
}
