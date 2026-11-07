// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
const { invokeMock, listeners } = vi.hoisted(() => ({ invokeMock: vi.fn(), listeners: { sidecar: [] as Listener[], drop: [] as Listener[] } }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, listener: Listener) => {
    listeners.sidecar.push(listener)
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve() }))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (listener: Listener) => {
      listeners.drop.push(listener)
      return Promise.resolve(() => {})
    },
  }),
}))

import StudioApp from './StudioApp'

// jsdom has no layout, so the chat's scroll to its newest line is a no-op here.
Element.prototype.scrollIntoView = vi.fn()

const projectA = { id: '2026-11-06-a', conversation: 2, title: 'Project A', createdMs: 2 }
const projectB = { id: '2026-11-06-b', conversation: 3, title: 'Project B', createdMs: 1 }
const view = (project: string, more: object = {}) => ({ project, entries: [], running: false, waiting: null, turn: null, seq: 1, ...more })
const settings = { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, thinking: 'high', printer: {} }

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
  listeners.sidecar.length = 0
  listeners.drop.length = 0
})

/** An event from the sidecar, as Rust forwards it to the window. */
const emit = (event: object) => act(() => listeners.sidecar.forEach((listener) => listener({ payload: event })))

const prompt = () => screen.getByTestId('prompt') as HTMLTextAreaElement
const type = (text: string) => fireEvent.change(prompt(), { target: { value: text } })

type Calls = Record<string, (params: Record<string, unknown>) => Promise<unknown>>

/** The sidecar as the window sees it: one `sidecar` command, by method. */
function mockSidecar(overrides: Calls = {}, projects = [projectB], drafts: Record<string, { text: string }> = {}) {
  invokeMock.mockImplementation((command: string, args: { method: string; params: Record<string, unknown> }) => {
    if (command === 'update_check') return Promise.resolve({ status: 'upToDate' })
    if (command === 'studio_files') return Promise.resolve([])
    if (overrides[command]) return overrides[command](args as unknown as Record<string, unknown>)
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

  it('keeps an engine stop that arrives while its version is still on the way', async () => {
    let answerPing: (value: unknown) => void = () => {}
    mockSidecar({ 'app.ping': () => new Promise((resolve) => (answerPing = resolve)) })
    render(<StudioApp />)
    await waitFor(() => expect(sidecarCalls('app.ping')).toHaveLength(1))
    await emit({ type: 'engine', state: 'stopped', detail: 'The engine stopped.' })
    await act(async () => answerPing({ version: '1.2.3' }))
    expect(screen.getByTestId('engine').textContent).toBe('The engine stopped.')
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
    let sends = 0
    mockSidecar(
      { 'chat.send': () => (++sends === 1 ? new Promise((_, reject) => (failSend = reject)) : Promise.resolve(null)) },
      [projectA, projectB],
    )
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
    // The send went through this time, so its failure is no longer shown.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('keeps a project made while the saved state was still on its way', async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({
      'state.get': () => new Promise((resolve) => (finishState = resolve)),
      'projects.create': () => Promise.resolve({ id: '2026-11-06-a-clip', conversation: 4, title: 'A clip for my desk', createdMs: 3 }),
    })
    render(<StudioApp />)
    fireEvent.change(await screen.findByTestId('prompt'), { target: { value: 'A clip for my desk' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    await act(async () => finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: {} }))
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    expect(sidebar.getByText('A clip for my desk')).toBeTruthy()
    expect(sidebar.getByText('Project B')).toBeTruthy()
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

  it('sending again after a lost reply sends the same pictures under the same request id', async () => {
    let sends = 0
    let imports = 0
    mockSidecar({
      studio_import_file: () => Promise.resolve(imports++ === 0 ? 'refs/photo.jpg' : `refs/photo-${imports}.jpg`),
      'chat.send': () => (sends++ === 0 ? Promise.reject('The engine restarted before it answered. Try again.') : Promise.resolve(null)),
    })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    await act(async () => listeners.drop.forEach((listener) => listener({ payload: { type: 'drop', paths: ['/Users/me/photo.jpg'] } })))
    type('A clip like this')
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(2))
    const [first, second] = sidecarCalls('chat.send')
    expect(second).toEqual(first)
    expect(first?.attachments).toEqual(['refs/photo.jpg'])
  })

  it('keeps chat changes that arrive while the chat opens', async () => {
    let finishOpen: (view: unknown) => void = () => {}
    mockSidecar({ 'chat.open': () => new Promise((resolve) => (finishOpen = resolve)) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    const reply = { id: 2, kind: 'assistant', text: 'The clip is ready.', calls: [] }
    await emit({ type: 'chat', ...view(projectB.id, { entries: [reply], seq: 3 }) })
    const asked = { id: 1, kind: 'user', text: 'A clip', images: [] }
    await act(async () => finishOpen(view(projectB.id, { entries: [asked], running: true, seq: 2 })))
    expect(screen.getByText('The clip is ready.')).toBeTruthy()
    expect(screen.getByText('A clip')).toBeTruthy()
    expect(screen.queryByTestId('working')).toBeNull()
  })

  it('reads the open chat again when the engine starts again, so a turn that ended before the crash shows as ended', async () => {
    let opens = 0
    mockSidecar({
      'chat.open': (params) => {
        opens += 1
        return Promise.resolve(view(String(params.project), opens === 1 ? { running: true, seq: 1 } : { running: false, seq: 5 }))
      },
    })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByTestId('working')
    await emit({ type: 'engine', state: 'restarting' })
    await emit({ type: 'ready', version: '1.2.3' })
    await waitFor(() => expect(screen.queryByTestId('working')).toBeNull())
    expect(sidecarCalls('chat.open')).toHaveLength(2)
  })

  it('keeps text typed during a send as the next message, even when it reads the same as the sent one', async () => {
    let finishSend: (value: unknown) => void = () => {}
    mockSidecar({ 'chat.send': () => new Promise((resolve) => (finishSend = resolve)) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    type('Make it blue')
    type('Make it red')
    await act(async () => finishSend(null))
    expect(prompt().value).toBe('Make it red')
  })

  it('never shows a turn as working again when a change read before the open chat arrives after it', async () => {
    let finishOpen: (view: unknown) => void = () => {}
    mockSidecar({ 'chat.open': () => new Promise((resolve) => (finishOpen = resolve)) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    const asked = { id: 1, kind: 'user', text: 'A clip', images: [] }
    await emit({ type: 'chat', ...view(projectB.id, { entries: [asked], running: true, seq: 2 }) })
    const reply = { id: 2, kind: 'assistant', text: 'The clip is ready.', calls: [] }
    await act(async () => finishOpen(view(projectB.id, { entries: [asked, reply], running: false, seq: 3 })))
    expect(screen.getByText('The clip is ready.')).toBeTruthy()
    expect(screen.queryByTestId('working')).toBeNull()
  })

  it('saves a draft at once when the person moves to another project', async () => {
    mockSidecar({}, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('make it blue')
    fireEvent.click(screen.getByText('Project A'))
    expect(sidecarCalls('drafts.set')).toEqual([{ key: projectB.id, text: 'make it blue', attachments: [] }])
  })

  it('keeps text typed while a send goes through as the draft', async () => {
    let finishSend: (value: null) => void = () => {}
    mockSidecar({ 'chat.send': () => new Promise((resolve) => (finishSend = resolve)) }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    type('make it blue')
    await act(async () => finishSend(null))
    fireEvent.click(screen.getByText('Project A'))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(prompt().value).toBe('make it blue'))
  })

  it('keeps what the person typed on the start screen when the saved state arrives', async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)) })
    render(<StudioApp />)
    type('A clip for my desk')
    await act(async () => finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: { new: { text: 'an older draft' } } }))
    expect(prompt().value).toBe('A clip for my desk')
  })

  it('leaves the start screen empty after its message was sent', async () => {
    mockSidecar({ 'projects.create': () => Promise.resolve(projectA) })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip for my desk')
    await waitFor(() => expect(sidecarCalls('drafts.set')).toEqual([{ key: 'new', text: 'A clip for my desk', attachments: [] }]))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    fireEvent.click(screen.getByTestId('new-project'))
    expect(prompt().value).toBe('')
  })

  it("keeps text typed while a new project is made as that project's draft", async () => {
    let finishCreate: (project: unknown) => void = () => {}
    mockSidecar({ 'projects.create': () => new Promise((resolve) => (finishCreate = resolve)) })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('projects.create')).toHaveLength(1))
    type('second message')
    // The pause saves it as the start screen's draft before the project is there.
    await waitFor(() => expect(sidecarCalls('drafts.set')).toContainEqual({ key: 'new', text: 'second message', attachments: [] }))
    await act(async () => finishCreate(projectA))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    expect(sidecarCalls('drafts.set')).toContainEqual({ key: projectA.id, text: 'second message', attachments: [] })
    const saves = sidecarCalls('drafts.set')
    expect(saves[saves.length - 1]).toEqual({ key: 'new', text: '', attachments: [] })
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(prompt().value).toBe('second message'))
  })

  it('never puts a sent message back on the start screen when text typed while the project was made was taken back', async () => {
    let finishCreate: (project: unknown) => void = () => {}
    mockSidecar({ 'projects.create': () => new Promise((resolve) => (finishCreate = resolve)) })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('projects.create')).toHaveLength(1))
    type('A clip for my desk, and')
    type('A clip for my desk')
    await act(async () => finishCreate(projectA))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 600))
    const restored = sidecarCalls('drafts.set').filter((save) => save.key === 'new' && save.text === 'A clip for my desk')
    expect(restored).toHaveLength(1)
    fireEvent.click(screen.getByTestId('new-project'))
    expect(prompt().value).toBe('')
  })

  it('leaves a start screen draft typed after leaving and coming back alone when the earlier project is made', async () => {
    let finishCreate: (project: unknown) => void = () => {}
    mockSidecar({ 'projects.create': () => new Promise((resolve) => (finishCreate = resolve)) })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('projects.create')).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    fireEvent.click(screen.getByTestId('new-project'))
    type('A shelf bracket')
    await act(async () => finishCreate(projectA))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(1))
    expect(prompt().value).toBe('A shelf bracket')
    // Once typing pauses, the bracket is the start screen's draft, never the new project's.
    await waitFor(() => expect(sidecarCalls('drafts.set')).toContainEqual({ key: 'new', text: 'A shelf bracket', attachments: [] }))
    expect(sidecarCalls('drafts.set')).not.toContainEqual(expect.objectContaining({ key: projectA.id, text: 'A shelf bracket' }))
  })

  it('leaves the start screen empty when the person cleared it before the saved state arrived', async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)) })
    render(<StudioApp />)
    type('A clip for my desk')
    type('')
    await act(async () => finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: { new: { text: 'an older draft' } } }))
    expect(prompt().value).toBe('')
  })

  it("keeps each project's unsent message, so sending it again after another project's send reuses its request id", async () => {
    let sends = 0
    mockSidecar(
      { 'chat.send': () => (sends++ === 0 ? Promise.reject('The engine restarted before it answered. Try again.') : Promise.resolve(null)) },
      [projectA, projectB],
    )
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    type('make it blue')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(2))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sidecarCalls('chat.send')).toHaveLength(3))
    const [first, , third] = sidecarCalls('chat.send')
    expect(third?.requestId).toBe(first?.requestId)
  })

  it('shows the code a device sign-in asks for, with its page', async () => {
    mockSidecar()
    render(<StudioApp />)
    await screen.findByText('Project B')
    await emit({ type: 'login', provider: 'openai-codex', step: 'open', url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' })
    const ask = screen.getByTestId('sign-in')
    expect(ask.textContent).toContain('ABCD-1234')
    expect(ask.textContent).toContain('https://auth.openai.com/codex/device')
    await emit({ type: 'login', provider: 'openai-codex', step: 'done' })
    expect(screen.queryByTestId('sign-in')).toBeNull()
  })

  it('answers what a sign-in asks in the window: a choice by its id, and typed text', async () => {
    mockSidecar()
    render(<StudioApp />)
    await screen.findByText('Project B')
    await emit({ type: 'login', provider: 'anthropic', step: 'ask', kind: 'select', message: 'Which account?', options: [{ id: 'max', label: 'Claude Max' }] })
    fireEvent.click(screen.getByText('Claude Max'))
    await emit({ type: 'login', provider: 'anthropic', step: 'ask', kind: 'manual_code', message: 'Paste the code' })
    fireEvent.change(screen.getByLabelText('Paste the code'), { target: { value: 'code#state' } })
    fireEvent.click(screen.getByText('Answer'))
    await waitFor(() =>
      expect(sidecarCalls('auth.answer')).toEqual([
        { provider: 'anthropic', text: 'max' },
        { provider: 'anthropic', text: 'code#state' },
      ]),
    )
    expect(screen.queryByTestId('sign-in')).toBeNull()
  })
})
