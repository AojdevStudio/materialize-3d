import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const Parameters = Type.Object({
  view: Type.Union(
    [
      Type.Literal('preview'),
      Type.Literal('browser'),
      Type.Literal('scad'),
      Type.Literal('monitor'),
      Type.Literal('queue'),
    ],
    { description: 'The app panel to navigate to' }
  ),
})

export const navigateToTool: AgentTool<typeof Parameters> = {
  name: 'navigate_to',
  label: 'Navigate',
  description:
    'Switch the app to a different panel. Available views: preview (3D viewer), browser (MakerWorld), scad (OpenSCAD editor), monitor (printer monitor), queue (print queue).',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'navigate_to', params)

    try {
      await invoke('set_active_view', { view: params.view })

      const viewNames: Record<string, string> = {
        preview: '3D Viewer',
        browser: 'MakerWorld Browser',
        scad: 'OpenSCAD Editor',
        monitor: 'Printer Monitor',
        queue: 'Print Queue',
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Navigated to ${viewNames[params.view] ?? params.view}.`,
          },
        ],
        details: { view: params.view },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error navigating: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
