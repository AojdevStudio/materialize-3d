import { ASTRA, type ChatEntry, type HandoffProgress, HELPER, type ModelChoice, RUN_PROGRAM, STEP_LINES, type ToolArgs, type ToolName } from '../../sidecar/src/protocol'

/** What a step does, which picks its icon. */
export type Action = 'read' | 'write' | 'run' | 'slice' | 'helper' | 'other'

/** Where a step stands. A `stopped` step's turn ended before the step did. */
export type StepState = 'running' | 'done' | 'failed' | 'stopped'

/**
 * One tool step. `label` says what it did once it ended, and `doing` says it in the present tense while it runs.
 * `summary` is the file or command it worked on. `result` is what it gave back, once it ended. `durationMs` is how long
 * it ran, once it ended.
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
  durationMs?: number
}

/** What the agent said while it worked, kept in its place among the steps. */
export type NoteItem = { kind: 'note'; text: string }

/**
 * A turn's run of steps, from its first step on. `running` is set on the open turn's trace while its turn runs. The
 * first step's id names it.
 */
export type TraceItem = { kind: 'trace'; id: string; lines: (ToolItem | NoteItem)[]; running: boolean }

/**
 * A task the lead handed its helper, as one entry of its own beside the traces. `id` is the call's id. `startedMs` is
 * when the call started, once it published its handoff. `durationMs` and `result` come once it ended. `progress` is
 * how far the helper got while it runs: its step count, and its newest step as a trace line says it.
 */
export type HandoffItem = {
  kind: 'handoff'
  id: string
  lead: ModelChoice
  helper: ModelChoice
  task: string
  state: StepState
  startedMs?: number
  durationMs?: number
  result?: string
  progress?: { steps: number; doing: string }
}

export type ChatItem =
  | { kind: 'user'; text: string; images: string[]; files: string[] }
  | { kind: 'byline'; model: ModelChoice }
  | { kind: 'text'; text: string }
  | TraceItem
  | HandoffItem

/** The result a step gets when its turn ended before the step did. */
export const STOPPED = 'It stopped before it finished.'

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** A committed call's args by the names `ToolArgs` gives them. The model sent them, so any can be missing or wrong. */
type SentArgs<T extends ToolName> = { [K in keyof ToolArgs[T]]?: unknown }

/**
 * One line for a tool step: what it did, and the file or command it did it with. The model sent `raw`, so it can be any
 * JSON. Only an object names any args, and the detail shows it as it came.
 */
function describe(name: string, raw: unknown): Omit<ToolItem, 'kind' | 'id' | 'state'> {
  const args: Record<string, unknown> = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {}
  const detail = JSON.stringify(raw ?? {}, null, 2)
  switch (name) {
    case 'read':
    case 'write':
    case 'edit': {
      const sent: SentArgs<typeof name> = args
      const path = str(sent.path)
      return { action: name === 'read' ? 'read' : 'write', ...STEP_LINES[name], summary: path, detail: path }
    }
    case 'run': {
      const sent: SentArgs<'run'> = args
      const command = [RUN_PROGRAM, ...(Array.isArray(sent.args) ? sent.args.map(str) : [])].join(' ')
      return { action: 'run', ...STEP_LINES.run, summary: command, detail: command }
    }
    case 'slice': {
      const sent: SentArgs<'slice'> = args
      return { action: 'slice', ...STEP_LINES.slice, summary: str(sent.output), detail }
    }
    case ASTRA:
    case HELPER: {
      const sent: SentArgs<typeof name> = args
      const task = str(sent.task)
      return { action: 'helper', ...STEP_LINES[name], summary: task.split('\n')[0] ?? '', detail: task }
    }
    default:
      return { action: 'other', label: name, doing: name, summary: '', detail }
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
 *
 * A `helper` call is a handoff entry of its own, which ends the trace it was in. The call's own handoff names its
 * helper: the one its result recorded, or while it runs, the one in `handoffs`, the open turn's running helper calls.
 * A call without a handoff stays a trace step: one that has not started its helper yet, one refused before it ran, a
 * result that recorded none, and every `astra` call from before pairs.
 */
export function buildChat(entries: ChatEntry[], running = true, handoffs: HandoffProgress[] = []): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ToolItem | HandoffItem>()
  // Each call's result, by the assistant entry that made the call and the call's id. A provider can give calls in
  // different turns the same id, so a result belongs to the newest call with its id before it.
  const results = new Map<string, Extract<ChatEntry, { kind: 'tool' }>>()
  const madeBy = new Map<string, number>()
  for (const entry of entries) {
    if (entry.kind === 'assistant') for (const call of entry.calls) madeBy.set(call.id, entry.id)
    if (entry.kind !== 'tool') continue
    const owner = madeBy.get(entry.callId)
    if (owner !== undefined) results.set(`${owner}:${entry.callId}`, entry)
  }
  // The open turn is the one after the newest message, so only its calls can still run.
  const openTurn = entries.map((entry) => entry.kind).lastIndexOf('user')
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
  /** A `helper` call as its handoff entry, or undefined when it has no handoff. */
  const handoffItem = (call: { id: string; args: unknown }, made: { id: number; model: ModelChoice }, inOpenTurn: boolean): HandoffItem | undefined => {
    const task = describe(HELPER, call.args).detail
    const lead = made.model
    const recorded = results.get(`${made.id}:${call.id}`)
    if (recorded !== undefined) {
      if (recorded.handoff === undefined) return undefined
      const { helper, startedMs } = recorded.handoff
      return { kind: 'handoff', id: call.id, lead, helper, task, state: 'running', startedMs }
    }
    const progress = inOpenTurn ? handoffs.find((live) => live.callId === call.id) : undefined
    if (progress === undefined) return undefined
    const { handoff, steps, last } = progress
    const newest = last === null ? undefined : describe(last.name, last.args)
    const doing = newest === undefined ? '' : [newest.doing, newest.summary].filter((part) => part !== '').join(' ')
    return { kind: 'handoff', id: call.id, lead, helper: handoff.helper, task, state: 'running', startedMs: handoff.startedMs, progress: { steps, doing } }
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
          const handoff = call.name === HELPER ? handoffItem(call, entry, i > openTurn) : undefined
          if (handoff !== undefined) {
            tools.set(call.id, handoff)
            items.push(handoff)
            trace = undefined
            continue
          }
          const item: ToolItem = { kind: 'tool', id: call.id, ...describe(call.name, call.args), state: 'running' }
          tools.set(call.id, item)
          step(item)
        }
        break
      case 'tool': {
        const item = tools.get(entry.callId)
        if (item === undefined) break
        item.durationMs = entry.durationMs
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
