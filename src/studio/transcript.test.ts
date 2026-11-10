import { describe, expect, it } from 'vitest'
import { buildChat } from './transcript'

describe('buildChat', () => {
  it('folds each tool step into one line with its result, and ends the turn with the files it wrote', () => {
    const items = buildChat([
      { id: 1, kind: 'user', text: 'A dock mount', images: ['refs/arm.jpg'], files: [] },
      {
        id: 2,
        kind: 'assistant',
        text: 'Writing the parameters.',
        calls: [
          { id: 'c1', name: 'write', args: { path: 'params.json', content: '{}' } },
          { id: 'c2', name: 'astra', args: { task: 'Draw it\nas an HTML page' } },
          { id: 'c3', name: 'slice', args: { inputs: ['clip.stl'], output: 'print/clip.3mf' } },
          { id: 'c4', name: 'write', args: { path: 'drawing.html', content: '<html>' } },
        ],
      },
      { id: 3, kind: 'tool', callId: 'c1', name: 'write', text: 'ok', failed: false },
      { id: 4, kind: 'tool', callId: 'c2', name: 'astra', text: 'drew it', failed: false },
      { id: 5, kind: 'tool', callId: 'c3', name: 'slice', text: 'Wrote print/clip.3mf', failed: false },
      { id: 6, kind: 'tool', callId: 'c4', name: 'write', text: 'no space left', failed: true },
      { id: 7, kind: 'assistant', text: 'Done.', calls: [] },
      { id: 8, kind: 'user', text: 'thanks', images: [], files: [] },
    ])
    expect(items).toEqual([
      { kind: 'user', text: 'A dock mount', images: ['refs/arm.jpg'], files: [] },
      { kind: 'text', text: 'Writing the parameters.' },
      { kind: 'tool', id: 'c1', label: 'Wrote', summary: 'params.json', detail: 'params.json', result: 'ok', failed: false },
      { kind: 'tool', id: 'c2', label: 'Astra (GPT)', summary: 'Draw it', detail: 'Draw it\nas an HTML page', result: 'drew it', failed: false },
      expect.objectContaining({ kind: 'tool', id: 'c3', label: 'Sliced', summary: 'print/clip.3mf', failed: false }),
      { kind: 'tool', id: 'c4', label: 'Wrote', summary: 'drawing.html', detail: 'drawing.html', result: 'no space left', failed: true },
      { kind: 'text', text: 'Done.' },
      { kind: 'files', files: ['print/clip.3mf'] },
      { kind: 'user', text: 'thanks', images: [], files: [] },
    ])
  })

  it('shows a step still running without a result, and a chat from before the store as it was', () => {
    const items = buildChat([
      { id: 1, kind: 'imported', role: 'user', text: 'A clip', images: [] },
      { id: 2, kind: 'imported', role: 'tool', name: 'Bash', text: 'Build the clip', result: 'clip.stl written', failed: false },
      { id: 3, kind: 'imported', role: 'assistant', text: 'Here it is.' },
      { id: 4, kind: 'user', text: 'Thicker', images: [], files: [] },
      { id: 5, kind: 'assistant', text: '', calls: [{ id: 'c1', name: 'run', args: { args: ['run', 'python', 'build/model.py'] } }] },
    ])
    expect(items).toEqual([
      { kind: 'user', text: 'A clip', images: [], files: [] },
      { kind: 'tool', id: 'imported-2', label: 'Ran', summary: 'Build the clip', detail: 'Build the clip', result: 'clip.stl written', failed: false },
      { kind: 'text', text: 'Here it is.' },
      { kind: 'user', text: 'Thicker', images: [], files: [] },
      { kind: 'tool', id: 'c1', label: 'Ran', summary: 'uv run python build/model.py', detail: 'uv run python build/model.py' },
    ])
  })

  it('shows a step left without a result as stopped once its turn no longer runs', () => {
    const entries = [
      { id: 1, kind: 'user' as const, text: 'Thicker', images: [], files: [] },
      { id: 2, kind: 'assistant' as const, text: '', calls: [{ id: 'c1', name: 'run', args: { args: ['run', 'python', 'build/model.py'] } }] },
    ]
    expect(buildChat(entries, false)[1]).toMatchObject({ kind: 'tool', id: 'c1', result: 'It stopped before it finished.', failed: true })
    expect(buildChat(entries, true)[1]).not.toHaveProperty('result')
    // A later message starts a new turn, which cannot run the earlier step again.
    const later = [...entries, { id: 3, kind: 'user' as const, text: 'Thinner', images: [], files: [] }]
    expect(buildChat(later, true)[1]).toMatchObject({ kind: 'tool', id: 'c1', result: 'It stopped before it finished.', failed: true })
  })
})
