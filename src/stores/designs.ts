import { Channel, invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import useTauriEvent from '../hooks/useTauriEvent'
import type {
  BuildOutcome,
  BuildStep,
  DesignsOpenPayload,
  Kind,
  LineageId,
  Revision,
  RevisionId,
  Sha256Hex,
} from '../types/designs'
import { useWorkspaceStore } from './workspace'

/** Every progress step in pipeline order, with the text the view shows for it. */
export const BUILD_STEPS = [
  ['spec_validated', 'Spec validated'],
  ['geometry_built', 'Geometry built'],
  ['package_written', 'Package written'],
  ['sliced', 'Sliced'],
  ['verified', 'Verified'],
] as const satisfies ReadonlyArray<readonly [BuildStep, string]>

/** The build started from the view header. Only one runs at a time. */
export type BuildRun =
  | { status: 'idle' }
  | { status: 'running'; buildId: string; done: BuildStep[] }
  | { status: 'reused'; number: number }
  | { status: 'error'; message: string }

interface DesignsState {
  /** Newest revisions across all designs, from `design_list`. */
  recent: Revision[]
  /** Every revision of the open design, newest first. */
  lineage: Revision[]
  /** The revision on screen, as last returned by `design_get` or an action. */
  selected: Revision | null
  /** The revision the view wants; responses for any other id are dropped. */
  selectedId: RevisionId | null
  build: BuildRun
  /** One-line failure of the last load or action. */
  error: string | null
  loadRecent: () => Promise<void>
  open: (id: RevisionId) => Promise<void>
  close: () => void
  refresh: () => Promise<void>
  /** Approves the package hash shown, acknowledging exactly the warnings shown (none for signs). */
  approve: (id: RevisionId, packageSha256: Sha256Hex, acknowledgedWarnings: string[]) => Promise<void>
  /** Returns the path written, or `null` after recording the error. */
  exportPackage: (id: RevisionId, destination: string) => Promise<string | null>
  recordPrint: (id: RevisionId, passed: boolean, note: string) => Promise<void>
  buildFromFile: (path: string, lineageId: LineageId | null, kind: Kind) => Promise<void>
  cancelBuild: () => Promise<void>
}

export const DESIGNS_DEFAULT_STATE = {
  recent: [] as Revision[],
  lineage: [] as Revision[],
  selected: null as Revision | null,
  selectedId: null as RevisionId | null,
  build: { status: 'idle' } as BuildRun,
  error: null as string | null,
}

const RECENT_LIMIT = 100

/** Tauri commands reject with the Rust error string; anything else is an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useDesignsStore = create<DesignsState>()((set, get) => {
  /** Applies a revision returned by an action to the detail and the lineage list. */
  const applyRevision = (revision: Revision) =>
    set((state) => ({
      selected: state.selectedId === revision.id ? revision : state.selected,
      lineage: state.lineage.map((row) => (row.id === revision.id ? revision : row)),
    }))

  return {
    ...DESIGNS_DEFAULT_STATE,

    loadRecent: async () => {
      try {
        set({ recent: await invoke<Revision[]>('design_list', { limit: RECENT_LIMIT }) })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    open: async (id) => {
      set({ selectedId: id, error: null })
      try {
        // design_get re-hashes an approved package, so a changed file arrives as a void approval.
        const revision = await invoke<Revision>('design_get', { id })
        const lineage = await invoke<Revision[]>('design_lineage', { lineageId: revision.lineage_id })
        if (get().selectedId === id) set({ selected: revision, lineage })
      } catch (error) {
        if (get().selectedId === id) set({ error: errorMessage(error) })
      }
    },

    close: () => set({ selectedId: null, selected: null, lineage: [], error: null }),

    refresh: async () => {
      const { selectedId, open, loadRecent } = get()
      await Promise.all([loadRecent(), selectedId ? open(selectedId) : undefined])
    },

    approve: async (id, packageSha256, acknowledgedWarnings) => {
      try {
        applyRevision(await invoke<Revision>('design_approve', { id, packageSha256, acknowledgedWarnings }))
      } catch (error) {
        // A package that changed on disk voids the approval; reload to show it.
        const message = errorMessage(error)
        await get().open(id)
        set({ error: message })
      }
    },

    exportPackage: async (id, destination) => {
      try {
        return await invoke<string>('design_export', { id, format: 'print_package', destination })
      } catch (error) {
        set({ error: errorMessage(error) })
        return null
      }
    },

    recordPrint: async (id, passed, note) => {
      try {
        applyRevision(await invoke<Revision>('design_record_print', { id, passed, note }))
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    buildFromFile: async (path, lineageId, kind) => {
      const buildId = crypto.randomUUID()
      set({ build: { status: 'running', buildId, done: [] }, error: null })
      const onProgress = new Channel<BuildStep>()
      onProgress.onmessage = (step) =>
        set((state) =>
          state.build.status === 'running' && state.build.buildId === buildId
            ? { build: { ...state.build, done: [...state.build.done, step] } }
            : {},
        )
      try {
        const text = await invoke<string>('read_text_file', { path })
        const spec: unknown = JSON.parse(text)
        const outcome = await invoke<BuildOutcome>('design_build', { kind, spec, lineageId, buildId, onProgress })
        set({ build: outcome.reused ? { status: 'reused', number: outcome.revision.number } : { status: 'idle' } })
        await Promise.all([get().open(outcome.revision.id), get().loadRecent()])
      } catch (error) {
        set({ build: { status: 'error', message: errorMessage(error) } })
        // A build that failed after it started is recorded as a failed revision.
        await get().refresh()
      }
    },

    cancelBuild: async () => {
      const { build } = get()
      if (build.status !== 'running') return
      try {
        await invoke<boolean>('design_cancel', { buildId: build.buildId })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },
  }
})

/**
 * App-level design listeners: `designs:changed` (payload: revision id) reloads
 * what the view shows, and `designs:open` (sent by the in-app agent) switches to
 * the designs view (still keyed `signs`) with that revision selected. Mount
 * once, in the app state bridge.
 */
export function useDesignsEvents() {
  useTauriEvent<RevisionId>('designs:changed', () => {
    void useDesignsStore.getState().refresh()
  })
  useTauriEvent<DesignsOpenPayload>('designs:open', ({ payload }) => {
    void useWorkspaceStore.getState().setActiveView('signs')
    void useDesignsStore.getState().open(payload.revisionId)
  })
}
