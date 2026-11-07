/**
 * Chats from before the store: each project folder kept its record in `.m3d/project.json` and its chat in
 * `.m3d/transcript.jsonl`, Claude Code stream-json events plus the app's own `m3d_*` events. Each one is imported
 * once, as display entries, and its files stay as they are. The old `m3d_files` cards are not kept: the Files tab lists
 * every file, and the preview opens the newest.
 */
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportedEntry } from './protocol'

/** How much of an old tool result the chat keeps. */
const RESULT_LIMIT = 4_000

/** What a step shows when the chat ended before its result came back, as when the old app quit mid-step. */
const CUT_OFF = 'It stopped before it finished.'

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
  const answered = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      break
    }
    // The old app read every line as a JSON value and matched only events, so it passed over anything else.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const event = parsed as Record<string, unknown>
    // A helper agent's inner steps stayed inside its one line.
    if (event.parent_tool_use_id) continue
    // Content in any form but a list of blocks, such as the plain text a few old lines held, has no steps to show.
    const content = (event.message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? content.filter((block): block is Block => typeof block === 'object' && block !== null) : []
    switch (event.type) {
      case 'm3d_user':
        entries.push({ role: 'user', text: str(event.text), images: Array.isArray(event.images) ? event.images.map(str) : [] })
        break
      case 'assistant':
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
        for (const block of blocks) {
          const tool = block.type === 'tool_result' && block.tool_use_id !== undefined ? tools.get(block.tool_use_id) : undefined
          if (tool === undefined) continue
          answered.add(block.tool_use_id ?? '')
          tool.result = resultText(block.content).slice(-RESULT_LIMIT)
          tool.failed = block.is_error === true
        }
        break
      case 'm3d_turn_end':
        if (event.ok === false) entries.push({ role: 'assistant', text: `The turn stopped: ${str(event.error)}` })
        break
    }
  }
  for (const [id, tool] of tools) {
    if (answered.has(id)) continue
    tool.result = CUT_OFF
    tool.failed = true
  }
  return entries
}

/**
 * Every old project in the projects folder that has a record, but those in `known`, whose files are not read. One with
 * no transcript yet comes with an empty chat. A project whose files cannot be read is skipped and named on stderr, as
 * the old app skipped it. `blocked` names the folder when it could not be read at all, as when macOS keeps Documents
 * from the app until the person allows it. The app still starts, and the import runs again at each start and when the
 * person asks, so it comes once the folder can be read.
 */
export function legacyProjects(projectsDir: string, known: ReadonlySet<string>): { found: LegacyProject[]; blocked: string | null } {
  const blocked = (error: unknown) => {
    console.error(`could not list ${projectsDir} for chats from before the store: ${error instanceof Error ? error.message : String(error)}`)
    return { found: [], blocked: projectsDir }
  }
  let dirs: Dirent[]
  try {
    // No projects folder, or something else in its place, holds no old chats.
    if (!statSync(projectsDir).isDirectory()) return { found: [], blocked: null }
    dirs = readdirSync(projectsDir, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { found: [], blocked: null }
    return blocked(error)
  }
  const found = dirs.flatMap((dir) => {
    const meta = join(projectsDir, dir.name, '.m3d')
    if (known.has(dir.name) || !dir.isDirectory() || !existsSync(join(meta, 'project.json'))) return []
    const transcript = join(meta, 'transcript.jsonl')
    try {
      const record = JSON.parse(readFileSync(join(meta, 'project.json'), 'utf8')) as { title?: unknown; createdMs?: unknown }
      return [
        {
          id: dir.name,
          title: str(record.title) || dir.name,
          createdMs: typeof record.createdMs === 'number' ? record.createdMs : 0,
          entries: existsSync(transcript) ? readTranscript(readFileSync(transcript, 'utf8')) : [],
        },
      ]
    } catch (error) {
      console.error(`skipped the old chat ${dir.name}, which could not be read: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })
  return { found, blocked: null }
}
