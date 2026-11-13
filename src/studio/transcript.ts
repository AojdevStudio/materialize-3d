import type { ChatEntry, ModelChoice } from '../../sidecar/src/protocol'

/** What a step does, which picks its icon. */
export type Action = 'read' | 'write' | 'run' | 'slice' | 'helper' | 'other'

/** Where a step stands. A `stopped` step's turn ended before the step did. */
export type StepState = 'running' | 'done' | 'failed' | 'stopped'

/**
 * One tool step. `label` says what it did once it ended, and `doing` says it in the present tense while it runs.
 * `summary` is the file or command it worked on. `result` is what it gave back, once it ended.
 */
export type ToolItem = {
  kind: 'tool'
  id: string
  action: Action
  label: string
  doing: string
  summary: string
  detail: string
  state: StepState
  result?: string
}

/** What the agent said while it worked, kept in its place among the steps. */
export type NoteItem = { kind: 'note'; text: string }

/**
 * A turn's run of steps, from its first step on. `running` is set on the open turn's trace while its turn runs. The
 * first step's id names it.
 */
export type TraceItem = { kind: 'trace'; id: string; lines: (ToolItem | NoteItem)[]; running: boolean }

export type ChatItem =
  | { kind: 'user'; text: string; images: string[]; files: string[] }
  | { kind: 'byline'; model: ModelChoice }
  | { kind: 'text'; text: string }
  | TraceItem

/** The result a step gets when its turn ended before the step did. */
export const STOPPED = 'It stopped before it finished.'

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** One line for a tool step: what it did, and the file or command it did it with. */
function describe(name: string, args: Record<string, unknown>): Omit<ToolItem, 'kind' | 'id' | 'state'> {
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

/**
 * Committed chat entries as chat items. A turn's reply opens with a byline that names the model it ran on. A reply
 * from before the store has none. A turn's tool steps gather in one trace, with each result attached and what the
 * agent said between them in its place. What it said before its first step shows above the trace, and an answer
 * without steps ends it. A step left without a result, as a stop or a crash leaves it, shows as stopped once a later
 * message starts a new turn, or once its own turn no longer `running`.
 */
export function buildChat(entries: ChatEntry[], running = true): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ToolItem>()
  /** The trace the next step joins. A message or an answer without steps closes it. */
  let trace: TraceItem | undefined
  let bylined = false
  const step = (item: ToolItem) => {
    if (trace === undefined) {
      trace = { kind: 'trace', id: item.id, lines: [], running: false }
      items.push(trace)
    }
    trace.lines.push(item)
  }
  // A step with no result that a later message or the end of its turn leaves behind was stopped, as a stop or a crash
  // leaves it. It cannot run again.
  const stopUnfinished = () => {
    for (const item of tools.values()) {
      if (item.state !== 'running') continue
      item.state = 'stopped'
      item.result = STOPPED
    }
  }
  const endTurn = () => {
    trace = undefined
    bylined = false
  }
  // An old chat came in one entry per block, so its narration between two steps is its own entry, like its answer. Text
  // with another imported step after it, before the next message, is narration. The last text in a turn is the answer.
  const stepAhead: boolean[] = []
  let ahead = false
  for (let i = entries.length - 1; i >= 0; i--) {
    stepAhead[i] = ahead
    const entry = entries[i]
    if (entry.kind === 'user' || (entry.kind === 'imported' && entry.role === 'user')) ahead = false
    else if (entry.kind === 'imported' && entry.role === 'tool') ahead = true
  }
  for (const [i, entry] of entries.entries()) {
    switch (entry.kind) {
      case 'user':
        endTurn()
        stopUnfinished()
        items.push({ kind: 'user', text: entry.text, images: entry.images, files: entry.files })
        break
      case 'assistant':
        if (!bylined && (entry.calls.length > 0 || entry.text.trim() !== '')) {
          items.push({ kind: 'byline', model: entry.model })
          bylined = true
        }
        if (entry.calls.length === 0) {
          if (entry.text.trim() !== '') items.push({ kind: 'text', text: entry.text })
          trace = undefined
          break
        }
        if (entry.text.trim() !== '') {
          if (trace === undefined) items.push({ kind: 'text', text: entry.text })
          else trace.lines.push({ kind: 'note', text: entry.text })
        }
        for (const call of entry.calls) {
          const args = (call.args ?? {}) as Record<string, unknown>
          const item: ToolItem = { kind: 'tool', id: call.id, ...describe(call.name, args), state: 'running' }
          tools.set(call.id, item)
          step(item)
        }
        break
      case 'tool': {
        const item = tools.get(entry.callId)
        if (item === undefined) break
        item.state = entry.failed ? 'failed' : 'done'
        item.result = entry.text
        break
      }
      case 'imported':
        if (entry.role === 'user') {
          endTurn()
          stopUnfinished()
          items.push({ kind: 'user', text: entry.text, images: entry.images, files: [] })
        } else if (entry.role === 'assistant') {
          if (trace !== undefined && stepAhead[i]) trace.lines.push({ kind: 'note', text: entry.text })
          else {
            items.push({ kind: 'text', text: entry.text })
            trace = undefined
          }
        } else {
          const { action, label } = OLD_STEPS[entry.name] ?? { action: 'other', label: entry.name }
          step({ kind: 'tool', id: `imported-${entry.id}`, action, label, doing: label, summary: entry.text, detail: entry.text, state: entry.failed ? 'failed' : 'done', result: entry.result })
        }
        break
    }
  }
  if (trace !== undefined) trace.running = running
  if (!running) stopUnfinished()
  return items
}
