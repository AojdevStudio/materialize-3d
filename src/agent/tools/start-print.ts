import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const Parameters = Type.Object({
  threemf_path: Type.String({ description: 'Path to the sliced 3MF file to print' }),
  use_ams: Type.Optional(
    Type.Boolean({ description: 'Whether to use the AMS for filament (default: false)' })
  ),
})

export const startPrintTool: AgentTool<typeof Parameters> = {
  name: 'start_print',
  label: 'Start Print',
  description:
    'Upload a sliced 3MF file to the printer via FTPS and start printing. The printer must be connected. Returns success status, filename, and MD5 hash.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'start_print', params)

    try {
      const result = await invoke('start_print', {
        path: params.threemf_path,
      })
      const r = result as Record<string, unknown>

      const lines: string[] = []
      if (r.success) {
        lines.push(`Print started successfully!`)
        lines.push(`File: ${r.filename}`)
        lines.push(`MD5: ${r.md5}`)
      } else {
        lines.push(`Print failed to start.`)
        if (r.error) lines.push(`Error: ${r.error}`)
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: result,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error starting print: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
