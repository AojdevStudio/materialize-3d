import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const Parameters = Type.Object({})

export const downloadModelTool: AgentTool<typeof Parameters> = {
  name: 'download_model',
  label: 'Download Model',
  description:
    'Download the currently detected model from the MakerWorld browser. Must be on a model page first (use search_makerworld + navigate). Returns import status and file paths.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    _params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'download_model', {})

    try {
      const result = await invoke('download_model')
      const r = result as Record<string, unknown>

      const lines: string[] = []
      lines.push(`Import status: ${r.importStatus ?? 'unknown'}`)
      if (Array.isArray(r.importedFiles) && r.importedFiles.length > 0) {
        lines.push(`Files: ${(r.importedFiles as string[]).join(', ')}`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: result,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error downloading model: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
