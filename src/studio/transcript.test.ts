import { describe, expect, it } from 'vitest'
import { buildChat } from './transcript'

const project = '/Users/o/Documents/Materialize 3D/2026-11-06-dock-mount'

describe('buildChat', () => {
  it('folds each tool step into one line with its result, and names Astra', () => {
    const chat = buildChat(
      [
        { type: 'm3d_user', text: 'A dock mount', images: ['refs/arm.jpg'] },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Writing the parameters.' },
              { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: `${project}/params.json`, content: '{}' } },
              { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'codex exec -c model_provider=cliproxy "draw it"', description: 'Astra draws the part' } },
            ],
          },
        },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'assistant', parent_tool_use_id: 't9', message: { content: [{ type: 'text', text: 'inner helper chatter' }] } },
        { type: 'm3d_files', files: ['params.json', 'drawing.html', 'build/astra.log', 'print/clip.3mf'] },
      ],
      project,
    )

    expect(chat.running).toBe(true)
    expect(chat.items).toEqual([
      { kind: 'user', text: 'A dock mount', images: ['refs/arm.jpg'] },
      { kind: 'text', text: 'Writing the parameters.' },
      expect.objectContaining({ kind: 'tool', label: 'Wrote', summary: 'params.json', result: 'ok', failed: false }),
      expect.objectContaining({ kind: 'tool', label: 'Astra (GPT)', summary: 'Astra draws the part' }),
      { kind: 'files', files: ['print/clip.3mf', 'drawing.html'] },
    ])
  })

  it('ends the turn, marks its unfinished step stopped, and shows its error', () => {
    const chat = buildChat(
      [
        { type: 'm3d_user', text: 'hi' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'python3 build/slice.py' } }] } },
        { type: 'm3d_turn_end', ok: false, error: 'Stopped.' },
      ],
      project,
    )
    expect(chat.running).toBe(false)
    expect(chat.items[1]).toEqual(expect.objectContaining({ kind: 'tool', failed: true, result: 'Stopped before it finished.' }))
    expect(chat.items[chat.items.length - 1]).toEqual({ kind: 'error', text: 'Stopped.' })
  })
})
