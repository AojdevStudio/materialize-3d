/**
 * The chat the window shows, read from committed entries only. A partial answer or running output is never shown, so
 * nothing on screen can vanish after a crash.
 */
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { ChatEntry, ImportedEntry } from './protocol'

type Content = string | readonly ({ type: string; text?: string } | { type: 'toolCall'; id: string; name: string; arguments: unknown })[]

/** The text of a message, whether it is a string or blocks. */
export function textOf(content: Content | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content.flatMap((block) => ('text' in block && typeof block.text === 'string' ? [block.text] : [])).join('\n')
}

/** One committed entry as the chat shows it, or nothing for entries only the model reads. */
export function chatEntry(entry: EntryRecord): ChatEntry | undefined {
  const message = entry.model?.[0]
  switch (entry.kind) {
    case 'm3d.imported':
      return { id: entry.id, kind: 'imported', ...(entry.data as ImportedEntry) }
    case 'm3d.user': {
      // A message from before files could be attached holds pictures only.
      const data = entry.data as { text: string; images: string[]; files?: string[] }
      return { id: entry.id, kind: 'user', text: data.text, images: data.images, files: data.files ?? [] }
    }
    case 'pi.assistant': {
      if (message?.role !== 'assistant') return undefined
      const calls = message.content.flatMap((block) =>
        block.type === 'toolCall' ? [{ id: block.id, name: block.name, args: block.arguments }] : [],
      )
      const text = textOf(message.content)
      // A request that failed leaves an empty answer behind. The waiting state says what happened.
      if (text === '' && calls.length === 0) return undefined
      return { id: entry.id, kind: 'assistant', text, calls }
    }
    case 'pi.tool-result': {
      if (message?.role !== 'toolResult') return undefined
      return { id: entry.id, kind: 'tool', callId: message.toolCallId, name: message.toolName, text: textOf(message.content), failed: message.isError }
    }
    default:
      return undefined
  }
}
