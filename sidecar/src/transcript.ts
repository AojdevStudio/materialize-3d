/**
 * The chat the window shows, read from committed entries only. A partial answer or running output is never shown, so
 * nothing on screen can vanish after a crash.
 */
import type { EntryRecord } from '@earendil-works/pi-durable'
import { Imported, UserMessage } from './entries'
import { type ChatEntry, type Handoff, HELPER } from './protocol'

type Content = string | readonly ({ type: string; text?: string } | { type: 'toolCall'; id: string; name: string; arguments: unknown })[]

export function textOf(content: Content | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : [])).join('\n')
}

/** One committed entry as the chat shows it, or nothing for entries only the model reads. */
export function chatEntry(entry: EntryRecord): ChatEntry | undefined {
  if (Imported.is(entry)) return { id: entry.id, kind: 'imported', ...entry.data }
  if (UserMessage.is(entry)) {
    const { text, images, files } = entry.data
    return { id: entry.id, kind: 'user', text, images, files: files ?? [] }
  }
  const message = entry.model?.[0]
  switch (entry.kind) {
    case 'pi.assistant': {
      if (message?.role !== 'assistant') return undefined
      const calls = message.content.flatMap((block) =>
        block.type === 'toolCall' ? [{ id: block.id, name: block.name, args: block.arguments }] : [],
      )
      const text = textOf(message.content)
      // A request that failed leaves an empty answer behind. The waiting state says what happened.
      if (text === '' && calls.length === 0) return undefined
      return { id: entry.id, kind: 'assistant', text, calls, model: { provider: message.provider, modelId: message.model } }
    }
    case 'pi.tool-result': {
      if (message?.role !== 'toolResult') return undefined
      const { durationMs } = message
      // A helper call keeps its handoff in its details from before it runs, so a result that failed holds it too.
      const handoff = message.toolName === HELPER ? (message.details as { handoff?: Handoff } | undefined)?.handoff : undefined
      return {
        id: entry.id,
        kind: 'tool',
        callId: message.toolCallId,
        name: message.toolName,
        text: textOf(message.content),
        failed: message.isError,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(handoff === undefined ? {} : { handoff }),
      }
    }
    default:
      return undefined
  }
}
