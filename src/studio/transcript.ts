import { autoOpens, is3mf, type StudioEvent } from './api'

export type ChatItem =
  | { kind: 'user'; text: string; images: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; label: string; summary: string; detail: string; result?: string; failed?: boolean }
  | { kind: 'files'; files: string[] }
  | { kind: 'error'; text: string }

export interface Chat {
  items: ChatItem[]
  running: boolean
}

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | { type: string; text?: string }[]
  is_error?: boolean
}

const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** The folder-relative form of a path the agent used, so a step reads `build/model.py`, not the full path. */
function short(path: string, projectPath: string): string {
  return path.startsWith(projectPath + '/') ? path.slice(projectPath.length + 1) : path
}

function describeTool(name: string, input: Record<string, unknown>, projectPath: string): { label: string; summary: string } {
  const path = short(str(input.file_path ?? input.path ?? input.notebook_path), projectPath)
  const command = str(input.command)
  switch (name) {
    case 'Bash':
      return command.includes('codex exec')
        ? { label: 'Astra (GPT)', summary: str(input.description) || 'Handed a task to Astra' }
        : { label: 'Ran', summary: str(input.description) || command.split('\n')[0] }
    case 'Write':
      return { label: 'Wrote', summary: path }
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Edited', summary: path }
    case 'Read':
      return { label: 'Read', summary: path }
    case 'Glob':
    case 'Grep':
      return { label: 'Searched', summary: str(input.pattern) }
    case 'WebFetch':
      return { label: 'Opened', summary: str(input.url) }
    case 'WebSearch':
      return { label: 'Searched the web', summary: str(input.query) }
    case 'Skill':
      return { label: 'Used skill', summary: str(input.skill) }
    case 'Agent':
    case 'Task':
      return { label: 'Helper', summary: str(input.description) }
    case 'TodoWrite':
      return { label: 'Planned', summary: 'Updated the step list' }
    default:
      return { label: name.replace(/^mcp__/, '').replace(/__/g, ' '), summary: '' }
  }
}

function resultText(content: ContentBlock['content']): string {
  if (typeof content === 'string') return content
  return (content ?? []).map((block) => block.text ?? `[${block.type}]`).join('\n')
}

/** Folds a project transcript into chat items: one line per tool step, with its result attached. */
export function buildChat(events: StudioEvent[], projectPath: string): Chat {
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  let running = false

  for (const event of events) {
    // A helper agent's inner steps stay inside its one line.
    if (event.parent_tool_use_id) continue
    switch (event.type) {
      case 'm3d_user':
        items.push({ kind: 'user', text: str(event.text), images: (event.images as string[] | undefined) ?? [] })
        running = true
        break
      case 'assistant': {
        const blocks = ((event.message as { content?: ContentBlock[] } | undefined)?.content ?? [])
        for (const block of blocks) {
          if (block.type === 'text' && block.text?.trim()) {
            items.push({ kind: 'text', text: block.text })
          } else if (block.type === 'tool_use' && block.id && block.name) {
            const input = block.input ?? {}
            const tool = {
              kind: 'tool' as const,
              id: block.id,
              ...describeTool(block.name, input, projectPath),
              detail: str(input.command) || JSON.stringify(input, null, 2),
            }
            tools.set(block.id, tool)
            items.push(tool)
          }
        }
        break
      }
      case 'user': {
        const blocks = ((event.message as { content?: ContentBlock[] | string } | undefined)?.content ?? [])
        if (typeof blocks === 'string') break
        for (const block of blocks) {
          const tool = block.type === 'tool_result' && block.tool_use_id ? tools.get(block.tool_use_id) : undefined
          if (tool) {
            tool.result = resultText(block.content)
            tool.failed = block.is_error === true
          }
        }
        break
      }
      case 'm3d_files': {
        // The card holds what Ossie looks at or prints, print files first. Scripts and logs stay in the Files tab.
        const files = ((event.files as string[] | undefined) ?? []).filter(autoOpens).sort((a, b) => Number(is3mf(b)) - Number(is3mf(a)))
        if (files.length > 0) items.push({ kind: 'files', files })
        break
      }
      case 'm3d_turn_end':
        running = false
        // A step with no result when its turn ends was stopped with it.
        for (const tool of tools.values()) {
          if (tool.result === undefined) {
            tool.result = 'Stopped before it finished.'
            tool.failed = true
          }
        }
        if (event.ok === false) items.push({ kind: 'error', text: str(event.error) })
        break
    }
  }
  return { items, running }
}
