import type { ChatEntry } from '../../sidecar/src/protocol'
import { autoOpens, is3mf } from './api'

/** What a step does, which picks its icon. */
export type Action = 'read' | 'write' | 'run' | 'slice' | 'helper' | 'other'

/**
 * One tool step. `label` says what it did once it finished, and `doing` says it in the present tense while it runs.
 * `summary` is the file or command it worked on. A step with no result yet still runs. `stopped` marks one whose turn
 * ended before it did.
 */
export type ToolItem = {
  kind: 'tool'
  id: string
  action: Action
  label: string
  doing: string
  summary: string
  detail: string
  result?: string
  failed?: boolean
  stopped?: boolean
}

/** What the agent said while it worked, kept in its place among the steps. */
export type NoteItem = { kind: 'note'; text: string }

/**
 * A turn's run of steps, from its first step on. It is `running` while its turn runs, `done` once an answer followed
 * it, and `stopped` when its turn ended or waits without one. The first step's id names it.
 */
export type TraceItem = { kind: 'trace'; id: string; lines: (ToolItem | NoteItem)[]; state: 'running' | 'done' | 'stopped' }

export type ChatItem =
  | { kind: 'user'; text: string; images: string[]; files: string[] }
  | { kind: 'text'; text: string }
  | TraceItem
  | { kind: 'files'; files: string[] }

/** The result a step gets when its turn ended before the step did. */
export const STOPPED = 'It stopped before it finished.'

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** One line for a tool step: what it did, and the file or command it did it with. */
function describe(name: string, args: Record<string, unknown>): Omit<ToolItem, 'kind' | 'id'> {
  const path = str(args.path)
  switch (name) {
    case 'read':
      return { action: 'read', label: 'Read', doing: 'Reading', summary: path, detail: path }
    case 'write':
      return { action: 'write', label: 'Wrote', doing: 'Writing', summary: path, detail: path }
    case 'edit':
      return { action: 'write', label: 'Edited', doing: 'Editing', summary: path, detail: path }
    case 'run': {
      const command = ['uv', ...(Array.isArray(args.args) ? args.args.map(str) : [])].join(' ')
      return { action: 'run', label: 'Ran', doing: 'Running', summary: command, detail: command }
    }
    case 'slice':
      return { action: 'slice', label: 'Sliced', doing: 'Slicing', summary: str(args.output), detail: JSON.stringify(args, null, 2) }
    case 'astra':
      return { action: 'helper', label: 'Asked Astra (GPT)', doing: 'Asking Astra (GPT)', summary: str(args.task).split('\n')[0] ?? '', detail: str(args.task) }
    default:
      return { action: 'other', label: name, doing: name, summary: '', detail: JSON.stringify(args, null, 2) }
  }
}

/** The steps of chats from before the store, which ran Claude Code's own tools. They all finished. */
const OLD_STEPS: Record<string, { action: Action; label: string }> = {
  Bash: { action: 'run', label: 'Ran' },
  Write: { action: 'write', label: 'Wrote' },
  Edit: { action: 'write', label: 'Edited' },
  MultiEdit: { action: 'write', label: 'Edited' },
  Read: { action: 'read', label: 'Read' },
  Skill: { action: 'other', label: 'Used skill' },
  Agent: { action: 'helper', label: 'Helper' },
  Task: { action: 'helper', label: 'Helper' },
}

/** The file a step wrote that the person may want to look at, once its result came back without an error. */
function written(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'write' || name === 'edit') return str(args.path) || undefined
  if (name === 'slice') return str(args.output) || undefined
  return undefined
}

/**
 * Committed chat entries as chat items. A turn's tool steps gather in one trace, with each result attached and what
 * the agent said between them in its place. What it said before its first step shows above the trace, and an answer
 * without steps ends it. After each turn comes a card of the files it wrote that open in the preview, print files
 * first. A step left without a result, as a stop or a crash leaves it, shows as stopped once a later message starts a
 * new turn, or once its own turn no longer `running`.
 */
export function buildChat(entries: ChatEntry[], running = true): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, { item: ToolItem; writes: string | undefined }>()
  let files: string[] = []
  /** The trace the next step joins. A message or an answer without steps closes it. */
  let trace: TraceItem | undefined
  /** An answer ends the open trace's turn, so the trace is done. */
  const answer = () => {
    if (trace !== undefined) trace.state = 'done'
    trace = undefined
  }
  const step = (item: ToolItem) => {
    if (trace === undefined) {
      trace = { kind: 'trace', id: item.id, lines: [], state: 'stopped' }
      items.push(trace)
    }
    trace.lines.push(item)
  }
  // A step with no result that a later message or the end of its turn leaves behind was stopped, as a stop or a crash
  // leaves it. It cannot run again.
  const stopUnfinished = () => {
    for (const { item } of tools.values()) {
      if (item.result !== undefined) continue
      item.result = STOPPED
      item.failed = true
      item.stopped = true
    }
  }
  const endTurn = () => {
    const shown = [...new Set(files)].filter(autoOpens).sort((a, b) => Number(is3mf(b)) - Number(is3mf(a)))
    if (shown.length > 0) items.push({ kind: 'files', files: shown })
    files = []
    trace = undefined
  }
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user':
        endTurn()
        stopUnfinished()
        items.push({ kind: 'user', text: entry.text, images: entry.images, files: entry.files })
        break
      case 'assistant':
        if (entry.calls.length === 0) {
          if (entry.text.trim() !== '') items.push({ kind: 'text', text: entry.text })
          answer()
          break
        }
        if (entry.text.trim() !== '') {
          if (trace === undefined) items.push({ kind: 'text', text: entry.text })
          else trace.lines.push({ kind: 'note', text: entry.text })
        }
        for (const call of entry.calls) {
          const args = (call.args ?? {}) as Record<string, unknown>
          const item: ToolItem = { kind: 'tool', id: call.id, ...describe(call.name, args) }
          tools.set(call.id, { item, writes: written(call.name, args) })
          step(item)
        }
        break
      case 'tool': {
        const call = tools.get(entry.callId)
        if (call === undefined) break
        call.item.result = entry.text
        call.item.failed = entry.failed
        if (!entry.failed && call.writes !== undefined) files.push(call.writes)
        break
      }
      case 'imported':
        if (entry.role === 'user') {
          endTurn()
          stopUnfinished()
          items.push({ kind: 'user', text: entry.text, images: entry.images, files: [] })
        } else if (entry.role === 'assistant') {
          items.push({ kind: 'text', text: entry.text })
          answer()
        } else {
          const { action, label } = OLD_STEPS[entry.name] ?? { action: 'other', label: entry.name }
          step({ kind: 'tool', id: `imported-${entry.id}`, action, label, doing: label, summary: entry.text, detail: entry.text, result: entry.result, failed: entry.failed })
        }
        break
    }
  }
  // The last turn's trace runs while its turn does.
  const open: TraceItem | undefined = trace
  endTurn()
  if (open !== undefined && running) open.state = 'running'
  if (!running) stopUnfinished()
  return items
}
