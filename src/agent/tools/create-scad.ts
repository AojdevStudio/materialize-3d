import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { useOpenScadStore } from '../../stores/openscadStore'

const Parameters = Type.Object({
  description: Type.String({
    description: 'Short description of the design (used to generate the filename)',
  }),
  code: Type.String({
    description: 'Complete OpenSCAD source code for the design',
  }),
})

/**
 * Generate a filesystem-safe slug from a description string.
 * Lowercase, replace non-alphanumeric runs with hyphens, trim to 40 chars, append timestamp.
 */
function generateSlug(description: string): string {
  const base = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const ts = Date.now()
  return `${base}-${ts}`
}

export const createScadTool: AgentTool<typeof Parameters> = {
  name: 'create_scad',
  label: 'Create Design',
  description:
    'Create a new OpenSCAD design file. Writes the .scad source, compiles it to STL, extracts parameters, and switches to the design view. Returns the file path, STL path, and parameter list on success, or a structured compile error on failure.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'create_scad', {
      description: params.description,
      codeLength: params.code.length,
    })

    try {
      // Get the persistent designs directory
      const designsDir = await invoke<string>('get_designs_dir')

      // Generate slug-based filename
      const slug = generateSlug(params.description)
      const scadPath = `${designsDir}/${slug}.scad`

      // Write the .scad file
      await invoke('write_text_file', { path: scadPath, content: params.code })

      // Extract parameters first (also sets loadedFile in the store via Tauri event)
      let paramResult: { parameters: Array<{ name: string; type: string; initial: number | string | boolean }> }
      try {
        paramResult = await invoke('openscad_extract_params', { path: scadPath })
      } catch {
        // Parameter extraction is non-fatal — file may have no params
        paramResult = { parameters: [] }
      }

      // Compile to STL
      try {
        const renderResult = await invoke<{
          stlPath: string
          stderrWarnings: string[]
          durationMs: number
        }>('openscad_render', { path: scadPath, overrides: null })

        // Switch to design view
        await invoke('set_active_view', { view: 'scad' })

        // Load file into the OpenSCAD store
        const store = useOpenScadStore.getState()
        store.applySnapshot({
          loadedFile: scadPath,
          parameters: paramResult.parameters as any,
          renderStatus: 'idle',
          lastStlPath: renderResult.stlPath,
          lastError: null,
        })

        const lines: string[] = []
        lines.push(`Design created successfully: ${params.description}`)
        lines.push(`File: ${scadPath}`)
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
            scadPath,
            stlPath: renderResult.stlPath,
            parameters: paramResult.parameters,
            durationMs: renderResult.durationMs,
            warnings: renderResult.stderrWarnings,
          },
        }
      } catch (renderError) {
        // Compile failed — return structured error for agent retry
        const store = useOpenScadStore.getState()
        const compileError = store.lastError

        const lines: string[] = []
        lines.push(`Compile error in design: ${params.description}`)
        lines.push(`File: ${scadPath}`)
        if (compileError) {
          lines.push(`Line ${compileError.line}: ${compileError.message}`)
        } else {
          const msg = renderError instanceof Error ? renderError.message : String(renderError)
          lines.push(`Error: ${msg}`)
        }
        lines.push('Fix the code and call modify_scad to retry.')

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          details: {
            scadPath,
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
        content: [{ type: 'text' as const, text: `Error creating design: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
