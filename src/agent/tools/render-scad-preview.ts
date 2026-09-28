import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { useOpenScadStore } from '../../stores/openscadStore'

const Parameters = Type.Object({})

export const renderScadPreviewTool: AgentTool<typeof Parameters> = {
  name: 'render_scad_preview',
  label: 'Render Preview',
  description:
    'Render the currently loaded OpenSCAD design to STL and switch to the design view. Returns the STL path, render duration, and any warnings.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    _params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'render_scad_preview', {})

    try {
      const { loadedFile, parameters } = useOpenScadStore.getState()

      if (!loadedFile) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No design file is currently loaded. Use create_scad first.',
            },
          ],
          details: { error: 'no file loaded' },
          isError: true,
        } as any
      }

      // Build overrides from current parameter values
      const overrides: Record<string, string> = {}
      for (const p of parameters) {
        overrides[p.name] = String(p.initial)
      }

      // Render
      const renderResult = await invoke<{
        stlPath: string
        stderrWarnings: string[]
        durationMs: number
      }>('openscad_render', {
        path: loadedFile,
        overrides: Object.keys(overrides).length > 0 ? overrides : null,
      })

      // Switch to design view
      await invoke('set_active_view', { view: 'scad' })

      const lines: string[] = []
      lines.push('Design rendered successfully.')
      lines.push(`File: ${loadedFile}`)
      lines.push(`STL: ${renderResult.stlPath}`)
      lines.push(`Render time: ${renderResult.durationMs}ms`)
      if (renderResult.stderrWarnings.length > 0) {
        lines.push(`Warnings: ${renderResult.stderrWarnings.join('; ')}`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: {
          scadPath: loadedFile,
          stlPath: renderResult.stlPath,
          durationMs: renderResult.durationMs,
          warnings: renderResult.stderrWarnings,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // Check for structured compile error from the store
      const compileError = useOpenScadStore.getState().lastError

      const lines: string[] = []
      lines.push('Render failed.')
      if (compileError) {
        lines.push(`Line ${compileError.line}: ${compileError.message}`)
      } else {
        lines.push(`Error: ${message}`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: {
          error: message,
          compileError: compileError ?? null,
        },
        isError: true,
      } as any
    }
  },
}
