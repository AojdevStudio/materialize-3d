import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const Parameters = Type.Object({
  path: Type.String({ description: 'Path to the model file to slice' }),
  quality: Type.Optional(
    Type.String({ description: 'Slice quality preset (e.g. "0.20mm", "0.12mm")' })
  ),
  filament: Type.Optional(
    Type.String({ description: 'Filament type (e.g. "PLA", "PETG")' })
  ),
})

export const sliceModelTool: AgentTool<typeof Parameters> = {
  name: 'slice_model',
  label: 'Slice Model',
  description:
    'Slice a 3D model file for printing. Returns estimated print time, filament usage, and layer count.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'slice_model', params)

    try {
      const result = await invoke('slice_model', {
        path: params.path,
        quality: params.quality,
        filament: params.filament,
      })
      const r = result as Record<string, unknown>

      const timeSeconds = r.estimatedTime as number | undefined
      let timeStr = 'unknown'
      if (timeSeconds != null) {
        const hours = Math.floor(timeSeconds / 3600)
        const minutes = Math.floor((timeSeconds % 3600) / 60)
        timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
      }

      const lines: string[] = []
      lines.push(`Slicing complete: ${r.success ? 'success' : 'failed'}`)
      if (r.gcodeFile) lines.push(`Output: ${r.gcodeFile}`)
      lines.push(`Estimated time: ${timeStr}`)
      if (r.filamentUsed != null) lines.push(`Filament: ${r.filamentUsed}g`)
      if (r.layerCount != null) lines.push(`Layers: ${r.layerCount}`)
      if (Array.isArray(r.warnings) && r.warnings.length > 0) {
        lines.push(`Warnings: ${(r.warnings as string[]).join(', ')}`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: result,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error slicing model: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
