import { describe, expect, it } from 'vitest'
import type { ChatView } from '../../sidecar/src/protocol'
import { chatEvent, merge } from './live'

const lead = { provider: 'faux', modelId: 'faux-a' }
const read: ChatView = { project: 'desk-clip', entries: [{ id: 1, kind: 'user', text: 'Draw it', images: [], files: [] }], running: true, waiting: null, turn: null, seq: 4 }

describe('a chat kept live from the event stream', () => {
  it('shows a turn that ends after the chat was read, from the stream event alone', () => {
    const ended = chatEvent({ type: 'chat', ...read, entries: [{ id: 2, kind: 'assistant', text: 'Here is the page.', calls: [], model: lead }], running: false, seq: 6 })
    if (ended === null) throw new Error('a chat event reads as a chat change')
    const shown = merge(read, ended)
    expect(shown.running).toBe(false)
    expect(shown.entries.map((entry) => entry.id)).toEqual([1, 2])
  })

  it('never puts back a running turn from a change older than the read', () => {
    const stale = { ...read, entries: [], running: true, seq: 3 }
    expect(merge({ ...read, running: false, seq: 6 }, stale).running).toBe(false)
  })

  it('reads only chat events', () => {
    expect(chatEvent({ type: 'project', project: 'desk-clip' })).toBeNull()
    expect(chatEvent({ type: 'chat', project: 'desk-clip', seq: '6', entries: [] })).toBeNull()
  })
})
