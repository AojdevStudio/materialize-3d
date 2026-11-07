// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(() => {}) }),
}))

import StudioApp from './StudioApp'

// jsdom has no layout, so the chat's scroll to its newest line is a no-op here.
Element.prototype.scrollIntoView = vi.fn()

const projectA = { id: '2026-11-06-a', conversation: 2, title: 'Project A', createdMs: 2 }
const projectB = { id: '2026-11-06-b', conversation: 3, title: 'Project B', createdMs: 1 }
const view = (project: string, more: object = {}) => ({ project, entries: [], running: false, waiting: null, turn: null, ...more })
const settings = { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, thinking: 'high', printer: {} }

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
})

type Calls = Record<string, (params: Record<string, unknown>) => Promise<unknown>>

/** The sidecar as the window sees it: one `sidecar` command, by method. */
function mockSidecar(overrides: Calls = {}, projects = [projectB], drafts: Record<string, { text: string }> = {}) {
  invokeMock.mockImplementation((command: string, args: { method: string; params: Record<string, unknown> }) => {
    if (command === 'update_check') return Promise.resolve({ status: 'upToDate' })
    if (command === 'studio_files') return Promise.resolve([])
    if (command !== 'sidecar') return Promise.resolve(undefined)
    const override = overrides[args.method]
    if (override) return override(args.params)
    switch (args.method) {
      case 'app.ping':
        return Promise.resolve({ version: '1.2.3' })
      case 'state.get':
        return Promise.resolve({ setup: { step: 'ready', done: true }, settings, projects, drafts })
      case 'chat.open':
        return Promise.resolve(view(String(args.params.project)))
      default:
        return Promise.resolve(null)
    }
  })
}

const sidecarCalls = (method: string) =>
  invokeMock.mock.calls.filter(([command, args]) => command === 'sidecar' && args.method === method).map(([, args]) => args.params)

describe('StudioApp', () => {
  it('shows the engine version the sidecar answers with', async () => {
    mockSidecar()
    render(<StudioApp />)
    expect((await screen.findByText('Engine 1.2.3')).dataset.testid).toBe('engine')
  })

  it('leaves the project the person moved to alone when a slow send from the start screen finishes', async () => {
    let finishCreate: (project: unknown) => void = () => {}
    mockSidecar({ 'projects.create': () => new Promise((resolve) => (finishCreate = resolve)) })
    render(<StudioApp />)
    await screen.findByText('Project B')

    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'A clip for my desk' } })
    fireEvent.click(screen.getByTestId('send'))
    fireEvent.click(screen.getByText('Project B'))
    await screen.findByRole('banner')
    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'draft for B' } })

    await act(async () => finishCreate({ id: '2026-11-06-a-clip', conversation: 4, title: 'A clip for my desk', createdMs: 2 }))
    await waitFor(() => expect(sidecarCalls('chat.send')).toEqual([expect.objectContaining({ project: '2026-11-06-a-clip', text: 'A clip for my desk' })]))
    expect(sidecarCalls('chat.send')[0]?.requestId).toEqual(expect.any(String))

    expect(screen.getByRole('banner').textContent).toBe('Project B')
    expect((screen.getByTestId('prompt') as HTMLTextAreaElement).value).toBe('draft for B')
  })

  it("keeps a slow send's failure with the project it was sent to, and sending again reuses its request id", async () => {
    let failSend: (reason: string) => void = () => {}
    mockSidecar({ 'chat.send': () => new Promise((_, reject) => (failSend = reject)) }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'A clip for my desk' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))

    await act(async () => failSend('The engine restarted before it answered. Try again.'))
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByText('Project A'))
    expect((await screen.findByRole('alert')).textContent).toContain('The engine restarted before it answered.')
    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'A clip for my desk' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(2))
    const [first, second] = sidecarCalls('chat.send')
    expect(second?.requestId).toBe(first?.requestId)
  })

  it('shows what a waiting turn needs, and a proxy sign-in goes to the sidecar', async () => {
    const waiting = { kind: 'login', provider: 'anthropic', name: 'Anthropic', fix: 'Sign in to Anthropic. The message picks up where it stopped.' }
    mockSidecar({ 'chat.open': (params) => Promise.resolve(view(String(params.project), { waiting })) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    expect((await screen.findByTestId('waiting')).textContent).toContain('Sign in to Anthropic. The message picks up where it stopped.')
    fireEvent.change(screen.getByLabelText('API key or token'), { target: { value: 'proxy-token' } })
    fireEvent.change(screen.getByLabelText('Proxy URL'), { target: { value: 'http://127.0.0.1:8317' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(sidecarCalls('auth.setKey')).toEqual([{ provider: 'anthropic', key: 'proxy-token', baseUrl: 'http://127.0.0.1:8317' }]))
  })

  it('saves the draft once typing pauses, and fills the composer with it when the project opens', async () => {
    mockSidecar({}, [projectB], { [projectB.id]: { text: 'make it red' } })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await waitFor(() => expect((screen.getByTestId('prompt') as HTMLTextAreaElement).value).toBe('make it red'))
    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'make it blue' } })
    await waitFor(() => expect(sidecarCalls('drafts.set')).toEqual([{ key: projectB.id, text: 'make it blue', attachments: [] }]))
  })
})
