import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  ChatModelAdapter,
  ChatModelRunResult,
  ThreadAssistantMessagePart,
  ThreadMessageLike,
} from '@assistant-ui/react'
import type { AgentErrorKind, AgentEvent, BuildStep, HistoryEntry } from '../../types/agent'

type ToolPart = Extract<ThreadAssistantMessagePart, { type: 'tool-call' }>
type ToolArgs = ToolPart['args']

/**
 * UI-only state carried on each tool-call part. `steps` lists completed
 * build_sign steps in order; `outcome` is set only for calls restored from
 * history that ended without a result (a live Stop is read from the part's
 * incomplete status instead).
 */
export interface ToolArtifact {
  steps: BuildStep[]
  outcome?: 'cancelled' | 'interrupted'
}

/** Error payload stored on an assistant message that ended with an `error` event. */
export interface AgentTurnError {
  code: AgentErrorKind
  message: string
}

export const BUILD_STEPS: readonly BuildStep[] = [
  'spec_validated',
  'geometry_built',
  'package_written',
  'sliced',
  'verified',
]

const isTerminal = (event: AgentEvent) =>
  event.type === 'turnFinished' || event.type === 'turnCancelled' || event.type === 'error'

/**
 * Turns the push-based Tauri Channel into a pull-based stream. It ends after
 * the terminal event, when agent_send rejects (as an `internal` error), or
 * when the run is aborted, so a Stop never waits on the backend to reply.
 */
function turnEvents(abortSignal: AbortSignal) {
  const queue: AgentEvent[] = []
  let wake: (() => void) | undefined
  const push = (event: AgentEvent) => {
    queue.push(event)
    wake?.()
  }
  const channel = new Channel<AgentEvent>()
  channel.onmessage = push
  abortSignal.addEventListener('abort', () => wake?.(), { once: true })

  async function* events(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const event = queue.shift()
      if (event) {
        yield event
        if (isTerminal(event)) return
        continue
      }
      if (abortSignal.aborted) return
      await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  return { channel, push, events: events() }
}

const argsOf = (args: unknown): ToolArgs =>
  args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as ToolArgs) : {}

function toolPart(callId: string, name: string, args: unknown, artifact: ToolArtifact): ToolPart {
  return {
    type: 'tool-call',
    toolCallId: callId,
    toolName: name,
    args: argsOf(args),
    argsText: JSON.stringify(args ?? {}),
    artifact,
  }
}

/**
 * Chat adapter for the Rust agent. Rust owns the conversation, so each run
 * sends only the newest user text. Yields the full cumulative content (text
 * after tool calls, in arrival order) on every event, as assistant-ui expects.
 */
export function createAgentAdapter(conversationId: string): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const last = messages[messages.length - 1]
      const text =
        last?.role === 'user'
          ? last.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
          : ''
      const turnId = crypto.randomUUID()
      const { channel, push, events } = turnEvents(abortSignal)

      abortSignal.addEventListener(
        'abort',
        () => void invoke<boolean>('agent_cancel', { turnId }).catch((err) => console.error('agent:cancel failed', err)),
        { once: true },
      )
      invoke<void>('agent_send', { conversationId, turnId, text, onEvent: channel }).catch((err: unknown) =>
        push({ type: 'error', kind: 'internal', message: err instanceof Error ? err.message : String(err) }),
      )

      const parts: ThreadAssistantMessagePart[] = []
      const tools = new Map<string, ToolPart>()
      const replaceTool = (callId: string, update: (part: ToolPart) => ToolPart) => {
        const current = tools.get(callId)
        if (!current) return
        const next = update(current)
        tools.set(callId, next)
        parts[parts.indexOf(current)] = next
      }
      const snapshot = (): ChatModelRunResult => ({ content: [...parts] })

      for await (const event of events) {
        switch (event.type) {
          case 'turnStarted':
            continue
          case 'textDelta': {
            const tail = parts[parts.length - 1]
            if (tail?.type === 'text') parts[parts.length - 1] = { type: 'text', text: tail.text + event.text }
            else parts.push({ type: 'text', text: event.text })
            break
          }
          case 'toolCall': {
            const part = toolPart(event.callId, event.name, event.args, { steps: [] })
            tools.set(event.callId, part)
            parts.push(part)
            break
          }
          case 'toolProgress':
            replaceTool(event.callId, (part) => {
              const { steps } = part.artifact as ToolArtifact
              return { ...part, artifact: { steps: [...steps, event.step] } satisfies ToolArtifact }
            })
            break
          case 'toolResult':
            replaceTool(event.callId, (part) => ({ ...part, result: event.output, isError: !event.ok }))
            break
          case 'turnFinished':
            return
          case 'turnCancelled':
            yield { ...snapshot(), status: { type: 'incomplete', reason: 'cancelled' } }
            return
          case 'error': {
            const error: AgentTurnError = { code: event.kind, message: event.message }
            yield { ...snapshot(), status: { type: 'incomplete', reason: 'error', error: { ...error } } }
            return
          }
        }
        yield snapshot()
      }
    },
  }
}

const HISTORY_OUTCOME = {
  completed: null,
  failed: null,
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  // A call still marked started was cut off before it could finish.
  started: 'interrupted',
} as const

/**
 * Maps Rust's linear history to thread messages. Assistant text and tool calls
 * that follow one user message share one assistant message, in order.
 */
export function historyToMessages(entries: readonly HistoryEntry[]): ThreadMessageLike[] {
  type Part = Exclude<ThreadMessageLike['content'], string>[number]
  const messages: { id: string; role: 'user' | 'assistant'; createdAt: Date; content: Part[] }[] = []

  const assistant = (id: string, createdAt: string) => {
    const tail = messages[messages.length - 1]
    if (tail?.role === 'assistant') return tail
    const message = { id, role: 'assistant' as const, createdAt: new Date(createdAt), content: [] as Part[] }
    messages.push(message)
    return message
  }

  for (const entry of entries) {
    switch (entry.role) {
      case 'user':
        messages.push({ id: entry.id, role: 'user', createdAt: new Date(entry.createdAt), content: [{ type: 'text', text: entry.text }] })
        break
      case 'assistant':
        assistant(entry.id, entry.createdAt).content.push({ type: 'text', text: entry.text })
        break
      case 'tool': {
        const outcome = HISTORY_OUTCOME[entry.status]
        const finished = entry.status === 'completed' && entry.name === 'build_sign'
        const artifact: ToolArtifact = { steps: finished ? [...BUILD_STEPS] : [], ...(outcome ? { outcome } : {}) }
        assistant(`tool-${entry.callId}`, entry.createdAt).content.push({
          ...toolPart(entry.callId, entry.name, entry.args, artifact),
          // Every restored call carries a result so the thread never waits on it.
          result: entry.output ?? null,
          isError: entry.status === 'failed',
        })
        break
      }
    }
  }

  return messages.map((message) =>
    message.role === 'assistant' ? { ...message, status: { type: 'complete', reason: 'unknown' } } : message,
  )
}
