import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { useOpenScadStore } from '../../stores/openscadStore'

const Parameters = Type.Object({
  code: Type.String({
    description: 'Updated OpenSCAD source code to replace the current file contents',
  }),
})

export const modifyScadTool: AgentTool<typeof Parameters> = {
  name: 'modify_scad',
  label: 'Modify Design',
  description:
    'Update the currently loaded OpenSCAD design with new code. Writes the updated source, recompiles to STL, and returns the result. Use this to fix compile errors or iterate on a design.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'modify_scad', { codeLength: params.code.length })

    try {
      // Get the currently loaded file from the store
      const { loadedFile } = useOpenScadStore.getState()

      if (!loadedFile) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No design file is currently loaded. Use create_scad first to create a design.',
            },
          ],
          details: { error: 'no file loaded' },
          isError: true,
        } as any
      }

      // Write updated code
      await invoke('write_text_file', { path: loadedFile, content: params.code })

      // Re-extract parameters
      let paramResult: { parameters: Array<{ name: string; type: string; initial: number | string | boolean }> }
      try {
        paramResult = await invoke('openscad_extract_params', { path: loadedFile })
      } catch {
        paramResult = { parameters: [] }
      }

      // Recompile
      try {
        const renderResult = await invoke<{
          stlPath: string
          stderrWarnings: string[]
          durationMs: number
        }>('openscad_render', { path: loadedFile, overrides: null })

        // Update store
        const store = useOpenScadStore.getState()
        store.applySnapshot({
          loadedFile,
          parameters: paramResult.parameters as any,
          renderStatus: 'idle',
          lastStlPath: renderResult.stlPath,
          lastError: null,
        })

        const lines: string[] = []
        lines.push('Design updated and compiled successfully.')
        lines.push(`File: ${loadedFile}`)
        lines.push(`STL: ${renderResult.stlPath}`)
        lines.push(`Render time: ${renderResult.durationMs}ms`)
        if (paramResult.parameters.length > 0) {
          lines.push(`Parameters (${paramResult.parameters.length}):`)
          for (const p of paramResult.parameters) {
            lines.push(`  - ${p.name}: ${p.initial}`)
          }
        }
        if (renderResult.stderrWarnings.length > 0) {
          lines.push(`Warnings: ${renderResult.stderrWarnings.join('; ')}`)
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          details: {
            scadPath: loadedFile,
            stlPath: renderResult.stlPath,
            parameters: paramResult.parameters,
            durationMs: renderResult.durationMs,
            warnings: renderResult.stderrWarnings,
          },
        }
      } catch (renderError) {
        // Compile failed — structured error for retry
        const store = useOpenScadStore.getState()
        const compileError = store.lastError

        const lines: string[] = []
        lines.push('Compile error after modification.')
        lines.push(`File: ${loadedFile}`)
        if (compileError) {
          lines.push(`Line ${compileError.line}: ${compileError.message}`)
        } else {
          const msg = renderError instanceof Error ? renderError.message : String(renderError)
          lines.push(`Error: ${msg}`)
        }
        lines.push('Review the error and call modify_scad again with fixed code.')

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          details: {
            scadPath: loadedFile,
            compileError: compileError ?? {
              line: 0,
              message: renderError instanceof Error ? renderError.message : String(renderError),
            },
          },
          isError: true,
        } as any
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error modifying design: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
