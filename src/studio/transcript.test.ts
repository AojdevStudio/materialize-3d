import { describe, expect, it } from 'vitest'
import { buildChat, STOPPED } from './transcript'

const opus = { provider: 'anthropic', modelId: 'claude-opus-5-5' }

describe('buildChat', () => {
  it("gathers a turn's steps in one trace with their results, and ends the turn with the files it wrote", () => {
    const items = buildChat([
      { id: 1, kind: 'user', text: 'A dock mount', images: ['refs/arm.jpg'], files: [] },
      {
        id: 2,
        kind: 'assistant',
        model: opus,
        text: 'Writing the parameters.',
        calls: [
          { id: 'c1', name: 'write', args: { path: 'params.json', content: '{}' } },
          { id: 'c2', name: 'astra', args: { task: 'Draw it\nas an HTML page' } },
        ],
      },
      { id: 3, kind: 'tool', callId: 'c1', name: 'write', text: 'ok', failed: false },
      { id: 4, kind: 'tool', callId: 'c2', name: 'astra', text: 'drew it', failed: false },
      {
        id: 5,
        kind: 'assistant',
        model: opus,
        text: 'Now the print file.',
        calls: [
          { id: 'c3', name: 'slice', args: { inputs: ['clip.stl'], output: 'print/clip.3mf' } },
          { id: 'c4', name: 'write', args: { path: 'drawing.html', content: '<html>' } },
        ],
      },
      { id: 6, kind: 'tool', callId: 'c3', name: 'slice', text: 'Wrote print/clip.3mf', failed: false },
      { id: 7, kind: 'tool', callId: 'c4', name: 'write', text: 'no space left', failed: true },
      { id: 8, kind: 'assistant', model: opus, text: 'Done.', calls: [] },
      { id: 9, kind: 'user', text: 'thanks', images: [], files: [] },
    ])
    expect(items).toEqual([
      { kind: 'user', text: 'A dock mount', images: ['refs/arm.jpg'], files: [] },
      { kind: 'byline', model: opus },
      // What the agent said before its first step stays above the trace. What it said after goes in the trace.
      { kind: 'text', text: 'Writing the parameters.' },
      {
        kind: 'trace',
        id: 'c1',
        running: false,
        lines: [
          { kind: 'tool', id: 'c1', action: 'write', label: 'Wrote', doing: 'Writing', summary: 'params.json', detail: 'params.json', state: 'done', result: 'ok' },
          { kind: 'tool', id: 'c2', action: 'helper', label: 'Asked Astra (GPT)', doing: 'Asking Astra (GPT)', summary: 'Draw it', detail: 'Draw it\nas an HTML page', state: 'done', result: 'drew it' },
          { kind: 'note', text: 'Now the print file.' },
          expect.objectContaining({ kind: 'tool', id: 'c3', action: 'slice', label: 'Sliced', doing: 'Slicing', summary: 'print/clip.3mf', state: 'done' }),
          { kind: 'tool', id: 'c4', action: 'write', label: 'Wrote', doing: 'Writing', summary: 'drawing.html', detail: 'drawing.html', state: 'failed', result: 'no space left' },
        ],
      },
      { kind: 'text', text: 'Done.' },
      { kind: 'files', files: ['print/clip.3mf'] },
      { kind: 'user', text: 'thanks', images: [], files: [] },
    ])
  })

  it('marks the last trace running while its turn runs, with its step still running, and a chat from before the store as it was', () => {
    const items = buildChat([
      { id: 1, kind: 'imported', role: 'user', text: 'A clip', images: [] },
      { id: 2, kind: 'imported', role: 'tool', name: 'Bash', text: 'Build the clip', result: 'clip.stl written', failed: false },
      { id: 3, kind: 'imported', role: 'assistant', text: 'Here it is.' },
      { id: 4, kind: 'user', text: 'Thicker', images: [], files: [] },
      { id: 5, kind: 'assistant', model: opus, text: '', calls: [{ id: 'c1', name: 'run', args: { args: ['run', 'python', 'build/model.py'] } }] },
    ])
    expect(items).toEqual([
      { kind: 'user', text: 'A clip', images: [], files: [] },
      {
        kind: 'trace',
        id: 'imported-2',
        running: false,
        lines: [{ kind: 'tool', id: 'imported-2', action: 'run', label: 'Ran', doing: 'Ran', summary: 'Build the clip', detail: 'Build the clip', state: 'done', result: 'clip.stl written' }],
      },
      { kind: 'text', text: 'Here it is.' },
      { kind: 'user', text: 'Thicker', images: [], files: [] },
      { kind: 'byline', model: opus },
      {
        kind: 'trace',
        id: 'c1',
        running: true,
        lines: [{ kind: 'tool', id: 'c1', action: 'run', label: 'Ran', doing: 'Running', summary: 'uv run python build/model.py', detail: 'uv run python build/model.py', state: 'running' }],
      },
    ])
  })

  it('keeps finished steps done when their turn ends without an answer', () => {
    const items = buildChat(
      [
        { id: 1, kind: 'user', text: 'A clip', images: [], files: [] },
        { id: 2, kind: 'assistant', model: opus, text: '', calls: [{ id: 'c1', name: 'write', args: { path: 'params.json' } }] },
        { id: 3, kind: 'tool', callId: 'c1', name: 'write', text: 'ok', failed: false },
      ],
      false,
    )
    expect(items[2]).toMatchObject({ kind: 'trace', running: false, lines: [{ id: 'c1', state: 'done', result: 'ok' }] })
  })

  it('keeps how long a finished step took', () => {
    const items = buildChat([
      { id: 1, kind: 'user', text: 'A clip', images: [], files: [] },
      { id: 2, kind: 'assistant', model: opus, text: '', calls: [{ id: 'c1', name: 'run', args: { args: ['run', 'python', 'build/model.py'] } }] },
      { id: 3, kind: 'tool', callId: 'c1', name: 'run', text: 'ok', failed: false, durationMs: 4200 },
    ])
    expect(items[2]).toMatchObject({ kind: 'trace', lines: [{ id: 'c1', state: 'done', durationMs: 4200 }] })
  })

  it('shows a step left without a result as stopped once its turn no longer runs', () => {
    const entries = [
      { id: 1, kind: 'user' as const, text: 'Thicker', images: [], files: [] },
      { id: 2, kind: 'assistant' as const, model: opus, text: '', calls: [{ id: 'c1', name: 'run', args: { args: ['run', 'python', 'build/model.py'] } }] },
    ]
    const stopped = { id: 'c1', state: 'stopped', result: STOPPED }
    expect(buildChat(entries, false)[2]).toMatchObject({ kind: 'trace', running: false, lines: [stopped] })
    expect(buildChat(entries, true)[2]).toMatchObject({ kind: 'trace', running: true, lines: [{ id: 'c1', state: 'running' }] })
    // A later message starts a new turn, which cannot run the earlier step again.
    const later = [...entries, { id: 3, kind: 'user' as const, text: 'Thinner', images: [], files: [] }]
    expect(buildChat(later, true)[2]).toMatchObject({ kind: 'trace', running: false, lines: [stopped] })
  })

  it("heads each turn's reply once with the model it ran on, and a reply from before the store with none", () => {
    const sol = { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }
    const items = buildChat(
      [
        { id: 1, kind: 'imported', role: 'user', text: 'A clip', images: [] },
        { id: 2, kind: 'imported', role: 'assistant', text: 'Here it is.' },
        { id: 3, kind: 'user', text: 'Thicker', images: [], files: [] },
        { id: 4, kind: 'assistant', model: opus, text: 'On it.', calls: [{ id: 'c1', name: 'write', args: { path: 'params.json' } }] },
        { id: 5, kind: 'tool', callId: 'c1', name: 'write', text: 'ok', failed: false },
        { id: 6, kind: 'assistant', model: opus, text: 'Done.', calls: [] },
        { id: 7, kind: 'user', text: 'Thinner', images: [], files: [] },
        { id: 8, kind: 'assistant', model: sol, text: 'Thinner now.', calls: [] },
      ],
      false,
    )
    expect(items.map((item) => item.kind)).toEqual(['user', 'text', 'user', 'byline', 'text', 'trace', 'text', 'user', 'byline', 'text'])
    expect(items.filter((item) => item.kind === 'byline')).toEqual([
      { kind: 'byline', model: opus },
      { kind: 'byline', model: sol },
    ])
  })
})
