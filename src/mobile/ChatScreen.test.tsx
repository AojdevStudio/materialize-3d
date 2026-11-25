// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ChatEntry, ChatView, MobileChat, ModelChoice } from '../../sidecar/src/protocol'

// The device keeps no draft for this chat yet, and takes each draft write.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
Element.prototype.scrollIntoView = () => {}

import ChatScreen from './ChatScreen'
import { SessionContext, type Session } from './live'
import { Sender } from './outbox'

/** The paired session a chat screen runs in, with the computer reachable and this chat's own outbox. */
const session = (): Session => {
  const sender = new Sender('bracket', 'connected', () => {})
  return { link: 'connected', sends: 0, listen: () => () => {}, sender: () => sender }
}

const ASTRA = { provider: 'openai-codex', modelId: 'gpt-6-astra' }
const SOL = { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }

/** One message whose lead handed its helper a task, and the helper's result. */
const handedOff = (at: number, lead: ModelChoice, helper: ModelChoice): ChatEntry[] => [
  { id: at, kind: 'user', text: 'Check the fit', images: [], files: [] },
  { id: at + 1, kind: 'assistant', text: '', calls: [{ id: `call-${at}`, name: 'helper', args: { task: 'Check the fit' } }], model: lead },
  { id: at + 2, kind: 'tool', callId: `call-${at}`, name: 'helper', text: 'It fits.', failed: false, durationMs: 68_000, handoff: { task: 't', conversation: at, helper, startedMs: 0 } },
]

const saved: ChatView = { project: 'bracket', entries: [...handedOff(1, ASTRA, SOL), ...handedOff(10, SOL, ASTRA)], running: false, waiting: null, turn: null, handoffs: [], seq: 1 }
const chat: MobileChat = { id: 'bracket', title: 'Shelf bracket', createdMs: 0, lead: SOL, helper: ASTRA, status: { running: false, printed: false, printFiles: 0, lastMs: 0 } }

vi.stubGlobal('fetch', async (url: string) => {
  const path = url.replace('m3dremote://localhost', '')
  if (path === '/api/v1/chats/bracket') return Response.json(saved)
  if (path === '/api/v1/chats/bracket/files') return Response.json([])
  if (path === '/api/v1/models') return Response.json([{ ...ASTRA, name: 'GPT 6 Astra', description: '' }, { ...SOL, name: 'GPT 6.1 Sol', description: '' }])
  return new Response('Not found', { status: 404 })
})

afterEach(cleanup)
// jsdom has no media queries. These tests run on a tablet, which shows the model beside the chat.
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }))

describe('ChatScreen', () => {
  it('names each saved handoff by the pair it ran with, and asks to save a lead picked for the next message', async () => {
    const picks: unknown[] = []
    const { container } = render(
      <SessionContext.Provider value={session()}>
        <ChatScreen chat={chat} writing={false} onPick={(change) => picks.push(change)} onBack={() => {}} />
      </SessionContext.Provider>,
    )
    await screen.findAllByTestId('handoff')
    const pairs = [...container.querySelectorAll('.mobile-chat-pane .handoff-who')].map((line) => line.textContent)
    expect(pairs).toEqual(['LeadAstraaskedhelperGPT 6.1 Sol', 'LeadGPT 6.1 SolaskedhelperAstra'])

    fireEvent.click(await screen.findByTestId('model-picker'))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Lead models' })).getByRole('menuitemradio', { name: 'GPT 6 Astra' }))
    expect(picks).toEqual([{ lead: ASTRA }])
  })

  it('shows no Working line on a chat opened while the computer is away, even when its last news was a running turn', async () => {
    const sender = new Sender('bracket', 'offline', () => {})
    sender.setRunning(true, 5)
    render(
      <SessionContext.Provider value={{ link: 'offline', sends: 0, listen: () => () => {}, sender: () => sender }}>
        <ChatScreen chat={chat} writing={false} onPick={() => {}} onBack={() => {}} />
      </SessionContext.Provider>,
    )
    await screen.findByRole('button', { name: 'Send' })
    expect(screen.queryByTestId('working')).toBeNull()
    // Send still waits for the turn the sender last heard of.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('brings the newest line into view on the way back from the Model tab, where the chat could not keep it', async () => {
    const scrolled: Element[] = []
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      scrolled.push(this)
    })
    render(
      <SessionContext.Provider value={session()}>
        <ChatScreen chat={chat} writing={false} onPick={() => {}} onBack={() => {}} />
      </SessionContext.Provider>,
    )
    await screen.findAllByTestId('handoff')
    fireEvent.click(screen.getByRole('tab', { name: 'Model' }))
    scrolled.length = 0
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }))
    const end = screen.getByTestId('messages').lastElementChild
    expect(scrolled).toContain(end)
    spy.mockRestore()
  })

  it('gives the role menus the room measured above the pickers, so a short screen scrolls the menu instead of losing it', async () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return DOMRect.fromRect({ x: 0, y: this.classList.contains('model-roles') ? 150 : 0, width: 100, height: 30 })
    })
    const { container } = render(
      <SessionContext.Provider value={session()}>
        <ChatScreen chat={chat} writing={false} onPick={() => {}} onBack={() => {}} />
      </SessionContext.Provider>,
    )
    await screen.findByTestId('helper-picker')
    const shown = container.querySelector<HTMLElement>('.mobile-chat')
    await waitFor(() => expect(shown?.style.getPropertyValue('--menu-room')).toBe('142px'))
    measured.mockRestore()
  })

  it('holds Send while a write to the computer is out, and lets it go after', async () => {
    const shared = session()
    const screenWith = (writing: boolean) => (
      <SessionContext.Provider value={shared}>
        <ChatScreen chat={chat} writing={writing} onPick={() => {}} onBack={() => {}} />
      </SessionContext.Provider>
    )
    const { rerender } = render(screenWith(true))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: 'Make it thicker' } })
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true)

    rerender(screenWith(false))
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(false)
  })
})
