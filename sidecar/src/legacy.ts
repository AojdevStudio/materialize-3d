/**
 * Chats from before the store: each project folder kept its record in `.m3d/project.json` and its chat in
 * `.m3d/transcript.jsonl`, Claude Code stream-json events plus the app's own `m3d_*` events. Each one is imported
 * once, as display entries, and its files stay as they are.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportedEntry } from './protocol'

/** How much of an old tool result the chat keeps. */
const RESULT_LIMIT = 4_000

export type LegacyProject = { id: string; title: string; createdMs: number; entries: ImportedEntry[] }

type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }

const str = (value: unknown) => (typeof value === 'string' ? value : '')

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block: Block) => block.text ?? `[${block.type}]`).join('\n')
}

/** What a tool step did, in a line: the description or command a shell step carried, or the path a file step used. */
function summary(input: Record<string, unknown>): string {
  return str(input.description) || str(input.command).split('\n')[0] || str(input.file_path ?? input.path) || str(input.skill)
}

/** The chat a transcript holds. A line it cannot read is a cut-off write and ends it, as the old app read them. */
export function readTranscript(text: string): ImportedEntry[] {
  const entries: ImportedEntry[] = []
  const tools = new Map<string, Extract<ImportedEntry, { role: 'tool' }>>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line)
    } catch {
      break
    }
    // A helper agent's inner steps stayed inside its one line.
    if (event.parent_tool_use_id) continue
    const blocks = ((event.message as { content?: Block[] | string } | undefined)?.content ?? []) as Block[] | string
    switch (event.type) {
      case 'm3d_user':
        entries.push({ role: 'user', text: str(event.text), images: Array.isArray(event.images) ? event.images.map(str) : [] })
        break
      case 'assistant':
        if (typeof blocks === 'string') break
        for (const block of blocks) {
          if (block.type === 'text' && block.text?.trim()) entries.push({ role: 'assistant', text: block.text })
          if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
            const tool = { role: 'tool' as const, name: block.name, text: summary(block.input ?? {}), result: '', failed: false }
            tools.set(block.id, tool)
            entries.push(tool)
          }
        }
        break
      case 'user':
        if (typeof blocks === 'string') break
        for (const block of blocks) {
          const tool = block.type === 'tool_result' && block.tool_use_id !== undefined ? tools.get(block.tool_use_id) : undefined
          if (tool === undefined) continue
          tool.result = resultText(block.content).slice(-RESULT_LIMIT)
          tool.failed = block.is_error === true
        }
        break
      case 'm3d_turn_end':
        if (event.ok === false) entries.push({ role: 'assistant', text: `The turn stopped: ${str(event.error)}` })
        break
    }
  }
  return entries
}

/** Every old project in the projects folder that has a record and a transcript. */
export function legacyProjects(projectsDir: string): LegacyProject[] {
  if (!existsSync(projectsDir)) return []
  return readdirSync(projectsDir, { withFileTypes: true }).flatMap((dir) => {
    const meta = join(projectsDir, dir.name, '.m3d')
    if (!dir.isDirectory() || !existsSync(join(meta, 'project.json')) || !existsSync(join(meta, 'transcript.jsonl'))) return []
    const record = JSON.parse(readFileSync(join(meta, 'project.json'), 'utf8')) as { title?: unknown; createdMs?: unknown }
    return [
      {
        id: dir.name,
        title: str(record.title) || dir.name,
        createdMs: typeof record.createdMs === 'number' ? record.createdMs : 0,
        entries: readTranscript(readFileSync(join(meta, 'transcript.jsonl'), 'utf8')),
      },
    ]
  })
}
