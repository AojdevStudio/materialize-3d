import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const Parameters = Type.Object({
  query: Type.String({ description: 'Search query for MakerWorld models' }),
})

export const searchMakerworldTool: AgentTool<typeof Parameters> = {
  name: 'search_makerworld',
  label: 'Search MakerWorld',
  description:
    'Search MakerWorld for 3D printable models. Opens the MakerWorld browser panel with search results.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'search_makerworld', params)

    try {
      await invoke('search_makerworld', { query: params.query })

      return {
        content: [
          {
            type: 'text' as const,
            text: `Searching MakerWorld for "${params.query}". The browser panel is now showing search results.`,
          },
        ],
        details: { query: params.query },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error searching MakerWorld: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
