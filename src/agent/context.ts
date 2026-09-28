import { usePrinterStore } from '../stores/printer'
import { useWorkspaceStore } from '../stores/workspace'
import { usePrintHistoryStore } from '../stores/printHistory'
import { useLibraryStore } from '../stores/libraryStore'
import { useOpenScadStore, type ScadParameter } from '../stores/openscadStore'
import { usePrinterConfigStore } from '../stores/printerConfigs'

/**
 * Base system prompt describing the agent's role as a 3D printing assistant.
 */
export const SYSTEM_PROMPT = `You are Materialize 3D's AI assistant — an expert 3D printing companion for Bambu Lab printers.

You help users find, prepare, and print 3D models. You have direct access to the printer, slicer, and MakerWorld model browser through your tools.

Capabilities:
- Check printer status (temperatures, print progress, connection state)
- Search MakerWorld for 3D models
- Download models from MakerWorld
- Slice models with configurable quality and filament settings
- Show models in the 3D viewer
- Navigate between app panels (preview, browser, monitor, queue)
- Start prints on the connected printer (FTPS upload + MQTT command)

## Guided Print Flow

When a user asks to print something, follow these checkpoints in order:

1. **Search**: Use search_makerworld to find models. Present the top results with names and ratings.
2. **Confirm model**: Wait for the user to pick a model before proceeding.
3. **Download**: Use download_model to import the chosen model files.
4. **Show profiles**: Use get_printer_status to check connection, then describe available quality presets (0.20mm Standard, 0.12mm Fine) and filament options.
5. **Confirm settings**: Wait for the user to confirm quality and filament choice.
6. **Slice**: Use slice_model with the chosen settings. Report estimated print time, filament usage, and layer count.
7. **Preview**: Use show_model to display the sliced result. Share the estimates and ask for confirmation.
8. **Confirm print**: Wait for explicit "go ahead" / "print it" / "yes" before starting.
9. **Print**: Use start_print with the sliced 3MF path. Report success or failure.

Never skip confirmation steps. Always check printer status before starting a print.

## Proactive Notifications

When you receive a message starting with "[Printer Event]", respond concisely — acknowledge what happened, mention the model name, and suggest a relevant next step (e.g. "want to start another print?" for completions, "want to retry?" for failures). Keep it to 1-2 sentences. Do not ask the user to confirm information already in the event message.

Guidelines:
- Be concise and action-oriented. Users want to print, not read essays.
- Report temperatures in °C. Report print times in human-friendly format (e.g. "45 minutes" not "2700 seconds").
- If the printer is disconnected, tell the user and suggest connecting first.
- When reporting AMS filament, include the color and type (e.g. "Slot 1: PLA, red").`

/**
 * Build a dynamic context string from current Zustand store state.
 * Called before each agent turn to inject live printer/workspace state.
 */
export function buildDynamicContext(): string {
  const printer = usePrinterStore.getState()
  const workspace = useWorkspaceStore.getState()

  console.debug('agent:context-refresh')

  const sections: string[] = []

  // Printer status section
  sections.push(buildPrinterSection(printer))

  // Printer config section (multi-printer identity)
  sections.push(buildPrinterConfigSection())

  // AMS state section
  sections.push(buildAmsSection(printer.amsState))

  // Active model section
  sections.push(buildActiveModelSection(workspace.activeModel))

  // Current view section
  sections.push(buildCurrentViewSection(workspace.activeView))

  // Print queue section
  sections.push(buildQueueSection())

  // Print history section
  sections.push(buildPrintHistorySection())

  // Model library section
  sections.push(buildLibrarySection())

  // OpenSCAD design section
  sections.push(buildOpenScadSection())

  // OpenSCAD design guidelines (only when in a design context)
  if (isDesignContextActive()) {
    sections.push(OPENSCAD_DESIGN_GUIDELINES)
  }

  return sections.join('\n\n')
}

function buildPrinterSection(
  printer: ReturnType<typeof usePrinterStore.getState>
): string {
  const lines = ['## Printer Status']

  lines.push(`Connection: ${printer.connectionState}`)
  lines.push(`Name: ${printer.name ?? '(none)'}`)

  if (printer.isConnected) {
    lines.push(
      `Nozzle: ${printer.nozzleTemp ?? '—'}°C / target ${printer.nozzleTargetTemp ?? '—'}°C`
    )
    lines.push(
      `Bed: ${printer.bedTemp ?? '—'}°C / target ${printer.bedTargetTemp ?? '—'}°C`
    )
    lines.push(`Chamber: ${printer.chamberTemp ?? '—'}°C`)
    lines.push(`GCode State: ${printer.gcodeState ?? '(none)'}`)

    if (printer.printProgress != null) {
      lines.push(`Print Progress: ${printer.printProgress}%`)
    }
    if (printer.remainingTime != null) {
      lines.push(`Remaining Time: ${printer.remainingTime}s`)
    }
    if (printer.subtaskName) {
      lines.push(`Current Task: ${printer.subtaskName}`)
    }
    if (printer.lastError) {
      lines.push(`Last Error: ${printer.lastError}`)
    }
  }

  return lines.join('\n')
}

function buildPrinterConfigSection(): string {
  const { configs, selectedPrinterId } = usePrinterConfigStore.getState()
  const lines = ['## Printer Config']

  if (configs.length === 0) {
    lines.push('(no saved printers)')
    return lines.join('\n')
  }

  const active = configs.find((c) => c.id === selectedPrinterId)

  if (active) {
    lines.push(`Active: ${active.name}`)
    lines.push(`Host: ${active.host}`)
    lines.push(`Serial: ${active.serial}`)
  } else {
    lines.push('Active: (none selected)')
  }

  lines.push(`Saved Printers: ${configs.length}`)

  return lines.join('\n')
}

function buildAmsSection(
  amsState: ReturnType<typeof usePrinterStore.getState>['amsState']
): string {
  const lines = ['## AMS State']

  if (!amsState || amsState.length === 0) {
    lines.push('(no AMS data)')
    return lines.join('\n')
  }

  for (const unit of amsState) {
    lines.push(`AMS Unit ${unit.id ?? '?'}:`)
    for (const tray of unit.trays) {
      if (tray.trayType) {
        lines.push(
          `  Slot ${tray.trayId ?? '?'}: ${tray.trayType}${tray.trayColor ? `, ${tray.trayColor}` : ''}`
        )
      } else {
        lines.push(`  Slot ${tray.trayId ?? '?'}: (empty)`)
      }
    }
  }

  return lines.join('\n')
}

function buildActiveModelSection(
  activeModel: ReturnType<typeof useWorkspaceStore.getState>['activeModel']
): string {
  const lines = ['## Active Model']

  if (!activeModel) {
    lines.push('(no model loaded)')
    return lines.join('\n')
  }

  lines.push(`Name: ${activeModel.name}`)
  if (activeModel.path) lines.push(`Path: ${activeModel.path}`)
  if (activeModel.source) lines.push(`Source: ${activeModel.source}`)

  return lines.join('\n')
}

function buildCurrentViewSection(activeView: string): string {
  return `## Current View\n${activeView}`
}

/**
 * Build a print queue context section.
 * Reads from window-level state if available; returns empty section in browser dev mode.
 */
function buildQueueSection(): string {
  const lines = ['## Print Queue']

  // In browser dev mode or when queue is empty, show placeholder
  try {
    const w = window as any
    if (w.__MATERIALIZE_QUEUE__) {
      const queue = w.__MATERIALIZE_QUEUE__ as Array<{
        id: string
        modelName: string
        status: string
        reason?: string
      }>
      if (queue.length === 0) {
        lines.push('(empty)')
      } else {
        for (const job of queue) {
          const statusStr =
            job.status === 'failed' && job.reason
              ? `failed: ${job.reason}`
              : job.status
          lines.push(`- ${job.modelName} [${statusStr}]`)
        }
      }
    } else {
      lines.push('(empty)')
    }
  } catch {
    lines.push('(empty)')
  }

  return lines.join('\n')
}

/**
 * Build a print history context section.
 * Shows the last 5 records from the print history store.
 */
function buildPrintHistorySection(): string {
  const lines = ['## Print History']

  const records = usePrintHistoryStore.getState().records
  if (records.length === 0) {
    lines.push('(no history)')
    return lines.join('\n')
  }

  const recent = records.slice(0, 5)
  for (const r of recent) {
    const duration = r.durationSeconds != null
      ? formatHistoryDuration(r.durationSeconds)
      : '?'
    const filament = r.filamentGrams != null ? `${r.filamentGrams.toFixed(1)}g` : '?'
    lines.push(`- ${r.modelName}: ${r.status} (${duration}, ${filament}) — ${r.completedAt}`)
  }

  if (records.length > 5) {
    lines.push(`(${records.length - 5} more)`)
  }

  return lines.join('\n')
}

function formatHistoryDuration(seconds: number): string {
  if (seconds < 60) return '<1m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/**
 * Build a model library context section.
 * Shows model count and up to 5 recent models with name and source.
 */
function buildLibrarySection(): string {
  const lines = ['## Model Library']

  const models = useLibraryStore.getState().models
  if (models.length === 0) {
    lines.push('(no models)')
    return lines.join('\n')
  }

  lines.push(`${models.length} model${models.length !== 1 ? 's' : ''} in library`)

  const recent = models.slice(0, 5)
  for (const m of recent) {
    const source = m.sourceUrl ? ` (${m.sourceUrl})` : ''
    lines.push(`- ${m.modelName}${source}`)
  }

  if (models.length > 5) {
    lines.push(`(${models.length - 5} more)`)
  }

  return lines.join('\n')
}

// ─── OpenSCAD Design Guidelines ───────────────────────────────────────────────

/**
 * Design guidelines injected into the system prompt when the user is
 * in a design context (has a loaded .scad file or is viewing the scad panel).
 */
export const OPENSCAD_DESIGN_GUIDELINES = `## OpenSCAD Design Guidelines

When generating or modifying OpenSCAD code, follow these rules:

1. **Resolution**: Always use \`$fn = 64;\` (or at minimum \`$fn >= 32\`) for curves. Never leave \`$fn\` at the default.
2. **Module pattern**: Wrap the design in \`module main() { ... } main();\` so the customizer can override parameters.
3. **Customizer annotations**: Add range annotations for numeric parameters: \`// [min:step:max]\`
4. **Centering**: Center the design on the XY plane with Z = 0 at the bottom (build-plate contact).
5. **Non-manifold prevention**: Extend subtracted shapes by 0.01mm beyond the surface to avoid coincident faces (e.g. \`translate([0,0,-0.01]) cube([w, d, h+0.02])\`).
6. **Wall thickness**: Minimum 1.2mm walls for FDM printing (3 perimeters at 0.4mm nozzle).
7. **Retry behavior**: If a compile error occurs, read the error line/message carefully, fix only that issue, and call modify_scad. Limit retries to 3 attempts before asking the user for guidance.
8. **Visual validation**: After a successful render, describe the shape to the user so they can confirm it matches their intent before iterating further.`

/**
 * Check whether the user is in a design context.
 * True when a .scad file is loaded OR the workspace view is 'scad'.
 */
export function isDesignContextActive(): boolean {
  const { loadedFile } = useOpenScadStore.getState()
  const { activeView } = useWorkspaceStore.getState()
  return loadedFile != null || activeView === 'scad'
}

// ─── OpenSCAD Section ─────────────────────────────────────────────────────────

function formatParamValue(p: ScadParameter): string {
  const val = String(p.initial)
  const parts = [val]
  if (p.min != null || p.max != null) {
    const range = `[${p.min ?? ''}..${p.max ?? ''}]`
    parts.push(range)
  }
  if (p.step != null) parts.push(`step ${p.step}`)
  return parts.join(' ')
}

/**
 * Build an OpenSCAD design context section.
 * Shows loaded file, parameters with current values, render status, and errors.
 */
export function buildOpenScadSection(): string {
  const lines = ['## OpenSCAD Design']

  const { loadedFile, parameters, renderStatus, lastStlPath, lastError } =
    useOpenScadStore.getState()

  if (!loadedFile) {
    lines.push('(no design loaded)')
    return lines.join('\n')
  }

  lines.push(`File: ${loadedFile}`)
  lines.push(`Render Status: ${renderStatus}`)

  if (lastStlPath) {
    lines.push(`Last STL: ${lastStlPath}`)
  }

  if (lastError) {
    lines.push(`Error (line ${lastError.line}): ${lastError.message}`)
  }

  if (parameters.length > 0) {
    lines.push('')
    lines.push('### Parameters')
    for (const p of parameters) {
      const group = p.group ? ` [${p.group}]` : ''
      lines.push(`- ${p.name}: ${formatParamValue(p)}${group}`)
    }
  } else {
    lines.push('Parameters: (none)')
  }

  return lines.join('\n')
}
