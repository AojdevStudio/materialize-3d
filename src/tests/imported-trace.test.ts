import { describe, expect, it } from 'vitest'
// The real importer, so the test sees the entries an old chat really becomes. It lives here, outside the typechecked
// `src`, because the importer reads files with Node and the window's typecheck has no Node types.
import { readTranscript } from '../../sidecar/src/legacy'
import { buildChat } from '../studio/transcript'

describe('an imported chat', () => {
  it('keeps narration between imported steps inside one trace, and the last answer outside it', () => {
    const lines = [
      { type: 'm3d_user', text: 'A clip' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'params.json' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '{}' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Now I write it.' }, { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: 'clip.py' } }] },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Here it is.' }] } },
      { type: 'm3d_user', text: 'Thanks' },
    ]
    const imported = readTranscript(lines.map((line) => JSON.stringify(line)).join('\n'))
    const chat = buildChat(imported.map((entry, i) => ({ id: i + 1, kind: 'imported' as const, ...entry })), false)
    expect(chat.map((item) => item.kind)).toEqual(['user', 'trace', 'text', 'user'])
    const trace = chat[1]
    if (trace.kind !== 'trace') throw new Error('expected a trace')
    expect(trace.lines.map((line) => line.kind)).toEqual(['tool', 'note', 'tool'])
    expect(chat[2]).toEqual({ kind: 'text', text: 'Here it is.' })
  })
})
