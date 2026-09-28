import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { useOpenScadStore } from '../../stores/openscadStore'

const Parameters = Type.Object({
  parameters: Type.Record(
    Type.String(),
    Type.Union([Type.String(), Type.Number()]),
    {
      description:
        'Map of parameter names to their new values. Values are passed as strings to OpenSCAD -D overrides.',
    }
  ),
})

export const setScadParametersTool: AgentTool<typeof Parameters> = {
  name: 'set_scad_parameters',
  label: 'Set Parameters',
  description:
    'Update OpenSCAD parameter values and re-render the design. Pass a map of parameter names to new values. The design is recompiled with the updated values.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'set_scad_parameters', params)

    try {
      const { loadedFile } = useOpenScadStore.getState()

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

      // Update parameter values in the store
      const store = useOpenScadStore.getState()
      for (const [name, value] of Object.entries(params.parameters)) {
        store.updateParameter(name, value)
      }

      // Build overrides map from the updated parameters
      const updatedParams = useOpenScadStore.getState().parameters
      const overrides: Record<string, string> = {}
      for (const p of updatedParams) {
        overrides[p.name] = String(p.initial)
      }

      // Render with overrides
      const renderResult = await invoke<{
        stlPath: string
        stderrWarnings: string[]
        durationMs: number
      }>('openscad_render', { path: loadedFile, overrides })

      const lines: string[] = []
      lines.push('Parameters updated and design re-rendered.')
      lines.push(`File: ${loadedFile}`)
      lines.push(`STL: ${renderResult.stlPath}`)
      lines.push(`Render time: ${renderResult.durationMs}ms`)
      lines.push('Updated values:')
      for (const [name, value] of Object.entries(params.parameters)) {
        lines.push(`  - ${name}: ${value}`)
      }
      if (renderResult.stderrWarnings.length > 0) {
        lines.push(`Warnings: ${renderResult.stderrWarnings.join('; ')}`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: {
          scadPath: loadedFile,
          stlPath: renderResult.stlPath,
          updatedParameters: params.parameters,
          durationMs: renderResult.durationMs,
          warnings: renderResult.stderrWarnings,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error setting parameters: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
