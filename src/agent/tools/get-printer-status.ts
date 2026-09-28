import { Type, type Static } from '@sinclair/typebox'
import { invoke } from '@tauri-apps/api/core'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const Parameters = Type.Object({})

export const getPrinterStatusTool: AgentTool<typeof Parameters> = {
  name: 'get_printer_status',
  label: 'Printer Status',
  description:
    'Get the current printer status including connection state, temperatures, print progress, and AMS filament information.',
  parameters: Parameters,

  async execute(
    _toolCallId: string,
    _params: Static<typeof Parameters>,
    _signal?: AbortSignal
  ) {
    console.debug('agent:tool-call', 'get_printer_status', {})

    try {
      const status = await invoke('get_printer_status')
      const s = status as Record<string, unknown>

      const lines: string[] = []
      lines.push(`Connection: ${s.connectionState ?? 'unknown'}`)
      lines.push(`Name: ${s.name ?? '(none)'}`)
      lines.push(`Connected: ${s.isConnected ? 'yes' : 'no'}`)

      if (s.isConnected) {
        lines.push(`Nozzle: ${s.nozzleTemp ?? '—'}°C / target ${s.nozzleTargetTemp ?? '—'}°C`)
        lines.push(`Bed: ${s.bedTemp ?? '—'}°C / target ${s.bedTargetTemp ?? '—'}°C`)
        lines.push(`Chamber: ${s.chamberTemp ?? '—'}°C`)
        lines.push(`GCode State: ${s.gcodeState ?? '(none)'}`)

        if (s.printProgress != null) {
          lines.push(`Print Progress: ${s.printProgress}%`)
        }
        if (s.remainingTime != null) {
          lines.push(`Remaining Time: ${s.remainingTime}s`)
        }
        if (s.subtaskName) {
          lines.push(`Current Task: ${s.subtaskName}`)
        }

        // AMS info
        const amsState = s.amsState as Array<{
          id: number | null
          trays: Array<{ trayId: number | null; trayType: string | null; trayColor: string | null }>
        }> | undefined
        if (amsState && amsState.length > 0) {
          lines.push('AMS:')
          for (const unit of amsState) {
            for (const tray of unit.trays) {
              if (tray.trayType) {
                lines.push(`  Slot ${tray.trayId ?? '?'}: ${tray.trayType}${tray.trayColor ? `, ${tray.trayColor}` : ''}`)
              }
            }
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        details: status,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error getting printer status: ${message}` }],
        details: { error: message },
        isError: true,
      } as any
    }
  },
}
