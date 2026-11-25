import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { chatEntry } from '../src/transcript'

const record = (id: number, kind: string, more: Pick<EntryRecord, 'data' | 'model'> = {}): EntryRecord => ({
  id: id as EntryId,
  conversationId: 1 as ConversationId,
  kind,
  ...more,
})

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

const assistant = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  usage,
  stopReason: 'stop',
  timestamp: 0,
})

const toolResult = (more: Partial<ToolResultMessage> = {}): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'run',
  content: [{ type: 'text', text: 'built' }, { type: 'text', text: 'parts.stl' }],
  isError: false,
  timestamp: 0,
  ...more,
})

describe('chatEntry', () => {
  test('an imported line keeps its own fields', () => {
    expect(chatEntry(record(1, 'm3d.imported', { data: { role: 'tool', name: 'run', text: 'python part.py', result: 'ok', failed: false } }))).toEqual({
      id: 1,
      kind: 'imported',
      role: 'tool',
      name: 'run',
      text: 'python part.py',
      result: 'ok',
      failed: false,
    })
  })

  test('a person\'s message holds its pictures and files, and one from before files holds none', () => {
    expect(chatEntry(record(2, 'm3d.user', { data: { text: 'A clip', images: ['refs/a.png'], files: ['refs/b.pdf'] } }))).toEqual({
      id: 2,
      kind: 'user',
      text: 'A clip',
      images: ['refs/a.png'],
      files: ['refs/b.pdf'],
    })
    expect(chatEntry(record(3, 'm3d.user', { data: { text: 'An old clip', images: [] } }))).toEqual({
      id: 3,
      kind: 'user',
      text: 'An old clip',
      images: [],
      files: [],
    })
  })

  test('an answer joins its text blocks, folds its tool calls, and names its model', () => {
    const message = assistant([
      { type: 'thinking', thinking: 'hidden' },
      { type: 'text', text: 'Here is the clip.' },
      { type: 'toolCall', id: 'call-1', name: 'run', arguments: { command: 'python part.py' } },
      { type: 'text', text: 'Slicing next.' },
    ])
    expect(chatEntry(record(4, 'pi.assistant', { model: [message] }))).toEqual({
      id: 4,
      kind: 'assistant',
      text: 'Here is the clip.\nSlicing next.',
      calls: [{ id: 'call-1', name: 'run', args: { command: 'python part.py' } }],
      model: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
    })
  })

  test('an answer with no text and no call, as a failed request leaves, shows nothing', () => {
    expect(chatEntry(record(5, 'pi.assistant', { model: [assistant([])] }))).toBeUndefined()
    expect(chatEntry(record(6, 'pi.assistant', { model: [assistant([{ type: 'thinking', thinking: 'only this' }])] }))).toBeUndefined()
  })

  test('a tool result keeps its duration only when it has one', () => {
    expect(chatEntry(record(7, 'pi.tool-result', { model: [toolResult({ durationMs: 1200 })] }))).toEqual({
      id: 7,
      kind: 'tool',
      callId: 'call-1',
      name: 'run',
      text: 'built\nparts.stl',
      failed: false,
      durationMs: 1200,
    })
    const plain = chatEntry(record(8, 'pi.tool-result', { model: [toolResult({ isError: true })] }))
    expect(plain).toEqual({ id: 8, kind: 'tool', callId: 'call-1', name: 'run', text: 'built\nparts.stl', failed: true })
    expect(plain !== undefined && 'durationMs' in plain).toBe(false)
  })

  test('a helper result holds its handoff, and a result of the Astra tool from before pairs keeps its name', () => {
    const handoff = { task: '41', conversation: 42, helper: { provider: 'faux', modelId: 'faux-b' } }
    const helper = toolResult({ toolName: 'helper', content: [{ type: 'text', text: 'drew it' }], details: { handoff } })
    expect(chatEntry(record(13, 'pi.tool-result', { model: [helper] }))).toEqual({ id: 13, kind: 'tool', callId: 'call-1', name: 'helper', text: 'drew it', failed: false, handoff })
    const astra = toolResult({ toolName: 'astra', content: [{ type: 'text', text: 'drew it' }], details: { astra: 42 } })
    expect(chatEntry(record(14, 'pi.tool-result', { model: [astra] }))).toEqual({ id: 14, kind: 'tool', callId: 'call-1', name: 'astra', text: 'drew it', failed: false })
  })

  test('entries only the model reads, and a kind whose message does not match it, show nothing', () => {
    expect(chatEntry(record(9, 'pi.user', { model: [{ role: 'user', content: 'hi', timestamp: 0 }] }))).toBeUndefined()
    expect(chatEntry(record(10, 'pi.assistant', { model: [toolResult()] }))).toBeUndefined()
    expect(chatEntry(record(11, 'pi.tool-result', { model: [assistant([{ type: 'text', text: 'x' }])] }))).toBeUndefined()
    expect(chatEntry(record(12, 'pi.assistant'))).toBeUndefined()
  })
})
