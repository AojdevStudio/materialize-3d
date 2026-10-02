// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { Channel } from '@tauri-apps/api/core'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react'
import type { AgentEvent, HistoryEntry } from '../types/agent'
import type { BuildResult } from '../types/generated'
import { ChatPanel } from '../components/ChatPanel'
import { createAgentAdapter } from '../components/chat/agentAdapter'
import { useAgentStore } from '../stores/agent'
import { UI_DEFAULT_STATE, useUiStore } from '../stores/ui'

// A fake Rust agent behind mockIPC: each agent_send hands its channel to the
// test, which then plays events and resolves the send.
interface Turn {
  conversationId: string
  turnId: string
  text: string
  emit: (event: AgentEvent) => void
  finish: () => void
}

let turns: Turn[]
let calls: { cmd: string; args: Record<string, unknown> }[]
let history: HistoryEntry[]

const SIGN: BuildResult = {
  revision_id: 'rev-2',
  lineage_id: 'lin-1',
  kind: 'sign',
  number: 2,
  title: 'Back Shortly door sign',
  build: 'verified',
  failure_reason: null,
  checks_passed: 9,
  checks_total: 9,
  failed_checks: [],
  warnings: [],
  package_sha256: 'abc123f09d1e7b55c0a4e2f6781d3b9ac0ffee12de45f67a89b0c1d2e3f4c4e7',
  approval: 'pending',
  print_validation: 'not_tested',
  requested_by: 'agent',
  created_at: '2026-10-02T10:00:00Z',
  reused: false,
}

beforeEach(() => {
  turns = []
  calls = []
  history = []
  useAgentStore.setState({ status: null })
  useUiStore.setState(UI_DEFAULT_STATE)
  mockIPC(
    (cmd, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>
      calls.push({ cmd, args })
      switch (cmd) {
        case 'agent_status':
          return { provider: 'anthropic', model: 'claude-sonnet-5', hasApiKey: true }
        case 'agent_history':
          return { conversationId: 'conv-1', entries: history }
        case 'agent_cancel':
          return true
        case 'agent_send':
          return new Promise<void>((finish) => {
            const channel = args.onEvent as Channel<AgentEvent>
            turns.push({
              conversationId: args.conversationId as string,
              turnId: args.turnId as string,
              text: args.text as string,
              emit: (event) => channel.onmessage(event),
              finish,
            })
          })
      }
      return undefined
    },
    { shouldMockEvents: true },
  )
})

afterEach(() => {
  cleanup()
  clearMocks()
})

async function sendMessage(text: string): Promise<Turn> {
  await screen.findByTestId('chat-input')
  fireEvent.change(screen.getByTestId('chat-input'), { target: { value: text } })
  fireEvent.click(screen.getByTestId('chat-send'))
  await waitFor(() => expect(turns.length).toBeGreaterThan(0))
  const turn = turns[turns.length - 1]!
  const play = turn.emit
  // Events arrive outside React; wrap them so assertions see the render.
  turn.emit = (event) => act(() => play(event))
  return turn
}

describe('agent adapter', () => {
  it('sends only the new user text and yields the full cumulative content each time', async () => {
    const adapter = createAgentAdapter('conv-1')
    const options = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
        { role: 'user', content: [{ type: 'text', text: 'Make a sign' }] },
      ],
      abortSignal: new AbortController().signal,
    } as unknown as ChatModelRunOptions
    const stream = adapter.run(options) as AsyncGenerator<ChatModelRunResult>

    const yields: ChatModelRunResult[] = []
    const collecting = (async () => {
      for await (const update of stream) yields.push(update)
    })()

    await waitFor(() => expect(turns).toHaveLength(1))
    const [turn] = turns
    expect(turn).toMatchObject({ conversationId: 'conv-1', text: 'Make a sign' })

    turn!.emit({ type: 'turnStarted', conversationId: 'conv-1', turnId: turn!.turnId })
    turn!.emit({ type: 'textDelta', text: 'Buil' })
    turn!.emit({ type: 'textDelta', text: 'ding.' })
    turn!.emit({ type: 'toolCall', callId: 'c1', name: 'build', args: { title: 'Sign' } })
    turn!.emit({ type: 'toolProgress', callId: 'c1', step: 'spec_validated' })
    turn!.emit({ type: 'toolResult', callId: 'c1', ok: true, output: SIGN })
    turn!.emit({ type: 'textDelta', text: 'Done' })
    turn!.emit({ type: 'turnFinished' })
    turn!.finish()
    await collecting

    expect(yields.map((y) => y.content?.length)).toEqual([1, 1, 2, 2, 2, 3])
    expect(yields[1]!.content).toEqual([{ type: 'text', text: 'Building.' }])
    expect(yields.at(-1)!.content).toMatchObject([
      { type: 'text', text: 'Building.' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'build', result: SIGN, isError: false, artifact: { steps: ['spec_validated'] } },
      { type: 'text', text: 'Done' },
    ])
  })
})

describe('ChatPanel', () => {
  it('shows build steps while running, then the result awaiting approval with no approve control', async () => {
    render(<ChatPanel />)
    expect(screen.getByLabelText('AI assistant panel').getAttribute('data-testid')).toBe('chat-panel')
    const turn = await sendMessage('Make a Back Shortly door sign')

    turn.emit({ type: 'turnStarted', conversationId: 'conv-1', turnId: turn.turnId })
    turn.emit({ type: 'toolCall', callId: 'c1', name: 'build', args: { title: 'Back Shortly door sign' } })
    turn.emit({ type: 'toolProgress', callId: 'c1', step: 'spec_validated' })
    turn.emit({ type: 'toolProgress', callId: 'c1', step: 'geometry_built' })

    const steps = await screen.findByTestId('tool-steps')
    expect([...steps.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'done1. Spec validated',
      'done2. Geometry built',
      'running3. Package written',
      'waiting4. Sliced',
      'waiting5. Verified',
    ])
    expect(screen.getByText('build, step 3 of 5')).toBeTruthy()
    expect(screen.getByTestId('chat-stop')).toBeTruthy()

    for (const step of ['package_written', 'sliced', 'verified'] as const) {
      turn.emit({ type: 'toolProgress', callId: 'c1', step })
    }
    turn.emit({ type: 'toolResult', callId: 'c1', ok: true, output: SIGN })
    turn.emit({ type: 'turnFinished' })
    await act(async () => turn.finish())

    const result = await screen.findByTestId('tool-result')
    expect(result.textContent).toContain('r2, Back Shortly door sign')
    expect(result.textContent).toContain('9 of 9 checks')
    expect(result.textContent).toContain('abc123f0…c4e7')
    expect(result.textContent).toContain('Awaiting your approval (the assistant cannot approve)')
    expect(screen.queryByTestId('tool-steps')).toBeNull()
    expect(within(screen.getByTestId('tool-build')).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
    await waitFor(() => expect(screen.queryByTestId('chat-stop')).toBeNull())
  })

  it('lists a warning apart from the checks and never counts it as a failure', async () => {
    render(<ChatPanel />)
    const turn = await sendMessage('Make a bracket')
    const warned: BuildResult = { ...SIGN, warnings: ['print.overhang.navy: 62 degrees unsupported'] }
    turn.emit({ type: 'toolCall', callId: 'c1', name: 'build', args: {} })
    turn.emit({ type: 'toolResult', callId: 'c1', ok: true, output: warned })
    turn.emit({ type: 'turnFinished' })
    await act(async () => turn.finish())

    const result = await screen.findByTestId('tool-result')
    const count = within(result).getByText('9 of 9 checks')
    expect(count.className).not.toMatch(/bad/)
    expect(result.textContent).toContain('Warning: print.overhang.navy: 62 degrees unsupported')
  })

  it('labels a build whose package changed as Invalid, not Failed', async () => {
    render(<ChatPanel />)
    const turn = await sendMessage('Show r2')
    const reason = 'package changed on disk (now 9f00) after approval'
    const invalid: BuildResult = { ...SIGN, build: 'invalid', failure_reason: reason, approval: 'void' }
    turn.emit({ type: 'toolCall', callId: 'c1', name: 'build', args: {} })
    turn.emit({ type: 'toolResult', callId: 'c1', ok: true, output: invalid })
    turn.emit({ type: 'turnFinished' })
    await act(async () => turn.finish())

    const result = await screen.findByTestId('tool-result')
    expect(result.textContent).toContain(`Invalid: ${reason}`)
    expect(result.textContent).not.toContain('Failed')
  })

  it('shows a missing key error that opens Settings', async () => {
    render(<ChatPanel />)
    const turn = await sendMessage('Retry that')
    turn.emit({ type: 'error', kind: 'missingApiKey', message: 'Anthropic API key is missing. The request was not sent.' })
    await act(async () => turn.finish())

    const error = await screen.findByTestId('chat-error')
    expect(error.textContent).toContain('Anthropic API key is missing. The request was not sent.')
    fireEvent.click(within(error).getByText('Open Settings'))
    expect(useUiStore.getState().settingsOpen).toBe(true)
  })

  it('Stop cancels the running turn by its turn id', async () => {
    render(<ChatPanel />)
    const turn = await sendMessage('Make a sign')
    turn.emit({ type: 'toolCall', callId: 'c1', name: 'build', args: {} })
    turn.emit({ type: 'toolProgress', callId: 'c1', step: 'spec_validated' })

    fireEvent.click(await screen.findByTestId('chat-stop'))

    await waitFor(() => expect(calls).toContainEqual({ cmd: 'agent_cancel', args: { turnId: turn.turnId } }))
    await waitFor(() => expect(screen.getByTestId('tool-build').textContent).toContain('Cancelled after 1 of 5 steps'))
  })

  it('renders history after reload, including an interrupted tool call', async () => {
    const at = '2026-09-26T10:00:00Z'
    history = [
      { role: 'user', id: 'u1', text: 'Make a Back Shortly door sign', createdAt: at },
      { role: 'assistant', id: 'a1', text: 'Building it now.', createdAt: at },
      { role: 'tool', callId: 'c1', name: 'build', args: {}, status: 'completed', output: SIGN, createdAt: at },
      { role: 'user', id: 'u2', text: 'Try one more', createdAt: at },
      { role: 'tool', callId: 'c2', name: 'build', args: {}, status: 'interrupted', output: null, createdAt: at },
    ]
    render(<ChatPanel />)

    expect(await screen.findByText('Make a Back Shortly door sign')).toBeTruthy()
    expect(screen.getByText('Building it now.')).toBeTruthy()
    expect(screen.getByText('Try one more')).toBeTruthy()
    const [finished, interrupted] = screen.getAllByTestId('tool-build')
    expect(within(finished!).getByTestId('tool-result').textContent).toContain('Awaiting your approval')
    expect(interrupted!.textContent).toContain('Interrupted, the app closed while it ran')
    expect(screen.queryByTestId('chat-stop')).toBeNull()
  })
})
