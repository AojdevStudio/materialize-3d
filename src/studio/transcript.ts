import type { ChatEntry } from '../../sidecar/src/protocol'
import { autoOpens, is3mf } from './api'

export type ChatItem =
  | { kind: 'user'; text: string; images: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; label: string; summary: string; detail: string; result?: string; failed?: boolean }
  | { kind: 'files'; files: string[] }

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** One line for a tool step: what it did, and the file or command it did it with. */
function describe(name: string, args: Record<string, unknown>): { label: string; summary: string; detail: string } {
  const path = str(args.path)
  switch (name) {
    case 'read':
      return { label: 'Read', summary: path, detail: path }
    case 'write':
      return { label: 'Wrote', summary: path, detail: path }
    case 'edit':
      return { label: 'Edited', summary: path, detail: path }
    case 'run': {
      const command = ['uv', ...(Array.isArray(args.args) ? args.args.map(str) : [])].join(' ')
      return { label: 'Ran', summary: command, detail: command }
    }
    case 'slice':
      return { label: 'Sliced', summary: str(args.output), detail: JSON.stringify(args, null, 2) }
    case 'astra':
      return { label: 'Astra (GPT)', summary: str(args.task).split('\n')[0] ?? '', detail: str(args.task) }
    default:
      return { label: name, summary: '', detail: JSON.stringify(args, null, 2) }
  }
}

/** The labels steps had in chats from before the store, which ran Claude Code's own tools. */
const OLD_LABELS: Record<string, string> = { Bash: 'Ran', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', Read: 'Read', Skill: 'Used skill', Agent: 'Helper', Task: 'Helper' }

/** The file a step wrote that the person may want to look at, once its result came back without an error. */
function written(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'write' || name === 'edit') return str(args.path) || undefined
  if (name === 'slice') return str(args.output) || undefined
  return undefined
}

/**
 * Committed chat entries as chat items: one line per tool step with its result attached, and after each turn a card
 * of the files it wrote that open in the preview, print files first. Once the turn no longer `running`, a step left
 * without a result, as a stop or a crash leaves it, shows as stopped.
 */
export function buildChat(entries: ChatEntry[], running = true): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, { item: ToolItem; writes: string | undefined }>()
  let files: string[] = []
  const endTurn = () => {
    const shown = [...new Set(files)].filter(autoOpens).sort((a, b) => Number(is3mf(b)) - Number(is3mf(a)))
    if (shown.length > 0) items.push({ kind: 'files', files: shown })
    files = []
  }
  for (const entry of entries) {
    switch (entry.kind) {
      case 'user':
        endTurn()
        items.push({ kind: 'user', text: entry.text, images: entry.images })
        break
      case 'assistant':
        if (entry.text.trim() !== '') items.push({ kind: 'text', text: entry.text })
        for (const call of entry.calls) {
          const args = (call.args ?? {}) as Record<string, unknown>
          const item: ToolItem = { kind: 'tool', id: call.id, ...describe(call.name, args) }
          tools.set(call.id, { item, writes: written(call.name, args) })
          items.push(item)
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
          items.push({ kind: 'user', text: entry.text, images: entry.images })
        } else if (entry.role === 'assistant') {
          items.push({ kind: 'text', text: entry.text })
        } else {
          items.push({ kind: 'tool', id: `imported-${entry.id}`, label: OLD_LABELS[entry.name] ?? entry.name, summary: entry.text, detail: entry.text, result: entry.result, failed: entry.failed })
        }
        break
    }
  }
  endTurn()
  if (!running) {
    for (const { item } of tools.values()) {
      if (item.result !== undefined) continue
      item.result = 'It stopped before it finished.'
      item.failed = true
    }
  }
  return items
}
