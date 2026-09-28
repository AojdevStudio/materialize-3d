import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const Parameters = Type.Object({
  path: Type.Optional(
    Type.String({ description: 'Path to the model file to display. If omitted, shows the currently active model.' })
  ),
})

export const showModelTool: AgentTool<typeof Parameters> = {
  name: 'show_model',
  label: 'Show Model',
  description:
    'Switch to the 3D model viewer to display a model. If a path is provided, that model will be shown.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'show_model', params)

    try {
      await invoke('set_active_view', { view: 'preview' })

      const modelInfo = params.path ? ` for ${params.path}` : ''
      console.debug('agent:show-model', params.path ?? '(active model)')

      return {
        content: [
          {
            type: 'text' as const,
            text: `Switched to model viewer${modelInfo}. The preview panel is now active.`,
          },
        ],
        details: { view: 'preview', path: params.path ?? null },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error showing model: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
