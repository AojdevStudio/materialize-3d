// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
const { invokeMock, listeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listeners: { sidecar: [] as Listener[], drop: [] as Listener[], flush: [] as Listener[] },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, listener: Listener) => {
    ;(name === 'studio://flush' ? listeners.flush : listeners.sidecar).push(listener)
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

import type { Project } from '../../sidecar/src/protocol'
import type { ProjectFile } from './api'
import StudioApp from './StudioApp'

// jsdom has no layout, so the chat's scroll to its newest line is a no-op here, and no object URLs for previews.
Element.prototype.scrollIntoView = vi.fn()
URL.createObjectURL = vi.fn(() => 'blob:preview')
URL.revokeObjectURL = vi.fn()

const projectA = { id: '2026-11-06-a', conversation: 2, title: 'Project A', createdMs: 2 }
const projectB = { id: '2026-11-06-b', conversation: 3, title: 'Project B', createdMs: 1 }
const view = (project: string, more: object = {}) => ({ project, entries: [], running: false, waiting: null, turn: null, seq: 1, ...more })
const settings = { model: { provider: 'anthropic', modelId: 'claude-opus-5-5' }, thinking: 'high', printer: {} }

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
  listeners.sidecar.length = 0
  listeners.drop.length = 0
  listeners.flush.length = 0
})

/** An event from the sidecar, as Rust forwards it to the window. */
const emit = (event: object) => act(() => listeners.sidecar.forEach((listener) => listener({ payload: event })))

const prompt = () => screen.getByTestId('prompt') as HTMLTextAreaElement
const type = (text: string) => fireEvent.change(prompt(), { target: { value: text } })
const drop = (paths: string[]) => act(async () => listeners.drop.forEach((listener) => listener({ payload: { type: 'drop', paths } })))
const pause = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

type Params = Record<string, unknown>
/** A call's own answer from the mocked sidecar, which an override may hold, fail, or pass on. */
type Calls = Record<string, (params: Params, real: () => Promise<unknown>) => Promise<unknown>>
type StoredDraft = { text: string; attachments: string[]; rev: number }

/** The revisions the mocked sidecar gives saved drafts, growing as the real one's do. */
let draftRevs = 0

const CHANGED = 'The draft changed before it went out. Send it again.'
const LOST = 'The engine restarted before it answered. Try again.'

/** Holds each call until `release`, then answers as the mocked sidecar would. */
function held() {
  let release = () => {}
  return {
    call: (_: Params, real: () => Promise<unknown>) => new Promise((resolve) => (release = () => resolve(real()))),
    release: () => act(async () => release()),
  }
}

/** A send whose first answer is lost after the sidecar sent it, as when the engine restarts. Later sends answer. */
function lostOnce() {
  let sends = 0
  return (_: Params, real: () => Promise<unknown>) => (sends++ === 0 ? real().then(() => Promise.reject(LOST)) : real())
}

/**
 * The sidecar as the window sees it: one `sidecar` command, by method. It keeps the drafts the window saves, and sends
 * one by its revision as the real sidecar does: a start screen send makes the project for that revision, or finds the
 * one it made, and moves the start draft there only when it is that revision. A send already made changes nothing. A
 * send removes the draft it sent. It answers with what it keeps, for a test to read.
 */
function mockSidecar(overrides: Calls = {}, projects: Project[] = [projectB], drafts: Record<string, { text: string; attachments?: string[]; rev?: number }> = {}, files: Record<string, ProjectFile[]> = {}) {
  const store = {
    projects: [...projects],
    drafts: Object.fromEntries(
      Object.entries(drafts).map(([key, draft]) => [key, { text: draft.text, attachments: draft.attachments ?? [], rev: draft.rev ?? ++draftRevs }]),
    ) as Record<string, StoredDraft>,
    madeFor: new Map<number, Project>(),
    /** Each message that went out. */
    sent: [] as { project: string; rev: number; text: string; attachments: string[] }[],
  }
  const send = (key: string, rev: number): Promise<unknown> => {
    let project = key === 'new' ? store.madeFor.get(rev) : store.projects.find((p) => p.id === key)
    if (project === undefined) {
      const start = store.drafts.new
      if (key !== 'new' || start?.rev !== rev) return Promise.reject(CHANGED)
      const title = start.text.split('\n')[0]?.trim() || 'New part'
      project = { id: `2026-11-06-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, conversation: 10 + store.projects.length, title, createdMs: 10 + store.projects.length }
      store.projects.push(project)
      store.madeFor.set(rev, project)
      store.drafts[project.id] = start
      delete store.drafts.new
    }
    const id = project.id
    if (store.sent.some((message) => message.project === id && message.rev === rev)) return Promise.resolve({ project })
    const draft = store.drafts[id]
    if (draft?.rev !== rev) return Promise.reject(CHANGED)
    store.sent.push({ project: id, rev, text: draft.text, attachments: draft.attachments })
    delete store.drafts[id]
    return Promise.resolve({ project })
  }
  const defaults = (method: string, params: Params): Promise<unknown> => {
    switch (method) {
      case 'app.ping':
        return Promise.resolve({ version: '1.2.3' })
      case 'state.get':
        return Promise.resolve(JSON.parse(JSON.stringify({ setup: { step: 'ready', done: true }, settings, projects: store.projects, drafts: store.drafts, importBlocked: null })))
      case 'chat.open':
        return Promise.resolve(view(String(params.project)))
      case 'setup.check':
        return Promise.resolve([])
      case 'drafts.set': {
        const rev = ++draftRevs
        const draft = { text: String(params.text), attachments: params.attachments as string[], rev }
        if (draft.text === '' && draft.attachments.length === 0) delete store.drafts[String(params.key)]
        else store.drafts[String(params.key)] = draft
        return Promise.resolve({ rev })
      }
      case 'chat.send':
        return send(String(params.key), Number(params.rev))
      default:
        return Promise.resolve(null)
    }
  }
  invokeMock.mockImplementation((command: string, args: { method: string; params: Params; project?: string }) => {
    if (command === 'update_check') return Promise.resolve({ status: 'upToDate' })
    if (command === 'studio_files') return Promise.resolve(files[String(args.project)] ?? [])
    if (command !== 'sidecar') return Promise.resolve(undefined)
    const real = () => defaults(args.method, args.params)
    const override = overrides[args.method]
    return override ? override(args.params, real) : real()
  })
  return store
}

const sidecarCalls = (method: string) =>
  invokeMock.mock.calls.filter(([command, args]) => command === 'sidecar' && args.method === method).map(([, args]) => args.params)
const sends = () => sidecarCalls('chat.send')
const saves = (key?: string) => sidecarCalls('drafts.set').filter((save) => key === undefined || save.key === key)
const last = <T,>(items: T[]) => items[items.length - 1]

describe('StudioApp', () => {
  it.each(['send', 'sidebar'])('keeps files, preview, tab, draft, and chat when reopening the project from %s', async (source) => {
    const title = source === 'send' ? 'A clip' : projectA.title
    const id = source === 'send' ? '2026-11-06-a-clip' : projectA.id
    mockSidecar({
      'chat.open': (params) => Promise.resolve(view(String(params.project), {
        entries: [{ id: 1, kind: 'assistant', text: 'The clip is ready.', calls: [] }],
      })),
    }, [projectA, projectB], {}, { [id]: [
      { rel: 'hello.html', size: 334, modifiedMs: 1 },
      { rel: 'newer.html', size: 100, modifiedMs: 2 },
    ] })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    await sidebar.findByText('Project B')
    if (source === 'send') {
      type(title)
      await waitFor(() => expect(screen.getByTestId('send').hasAttribute('disabled')).toBe(false))
      fireEvent.click(screen.getByTestId('send'))
    } else {
      fireEvent.click(sidebar.getByText(title))
    }
    await screen.findByTestId('html-preview')
    fireEvent.click(screen.getByTestId('files-tab'))
    fireEvent.click(within(screen.getByTestId('files-list')).getByText('hello.html'))
    type('Make it blue')

    fireEvent.click(sidebar.getByText(title))
    expect(screen.getByTestId('html-preview').getAttribute('src')).toContain('/hello.html?')
    expect(prompt().value).toBe('Make it blue')
    expect(screen.getByText('The clip is ready.')).toBeTruthy()
    fireEvent.click(screen.getByTestId('files-tab'))
    fireEvent.click(sidebar.getByText(title))
    expect(screen.getByTestId('files-tab').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('files-list').textContent).toContain('hello.html')

    fireEvent.click(sidebar.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    fireEvent.click(sidebar.getByText(title))
    expect((await screen.findByTestId('html-preview')).getAttribute('src')).toContain('/newer.html?')
    expect(prompt().value).toBe('Make it blue')
    fireEvent.click(screen.getByTestId('files-tab'))
    expect(screen.getByTestId('files-list').textContent).toContain('hello.html')
  })

  it('retries a failed chat load when reopening the same project without losing files or preview', async () => {
    let opens = 0
    mockSidecar({
      'chat.open': (params) => ++opens === 1
        ? Promise.reject('The chat could not be loaded.')
        : Promise.resolve(view(String(params.project), {
          entries: [{ id: 1, kind: 'assistant', text: 'The clip is ready.', calls: [] }],
        })),
    }, [projectB], {}, { [projectB.id]: [{ rel: 'hello.html', size: 334, modifiedMs: 1 }] })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    fireEvent.click(await sidebar.findByText('Project B'))
    expect((await screen.findByRole('alert')).textContent).toContain('The chat could not be loaded.')
    expect((await screen.findByTestId('html-preview')).getAttribute('src')).toContain('/hello.html?')
    fireEvent.click(screen.getByTestId('files-tab'))
    expect(screen.getByTestId('files-list').textContent).toContain('hello.html')

    fireEvent.click(sidebar.getByText('Project B'))
    expect(await screen.findByText('The clip is ready.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('files-tab').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('files-list').textContent).toContain('hello.html')
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(screen.getByTestId('html-preview').getAttribute('src')).toContain('/hello.html?')
  })

  it('keeps a pending chat load and its buffered changes when reopening the same project', async () => {
    const opening = held()
    mockSidecar({ 'chat.open': opening.call })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    fireEvent.click(await sidebar.findByText('Project B'))
    await screen.findByRole('banner')
    await emit({ type: 'chat', ...view(projectB.id, {
      entries: [{ id: 1, kind: 'assistant', text: 'The clip is ready.', calls: [] }], seq: 2,
    }) })
    fireEvent.click(sidebar.getByText('Project B'))
    expect(sidecarCalls('chat.open')).toHaveLength(1)
    await opening.release()
    expect(await screen.findByText('The clip is ready.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retries a chat load only after the pending load fails', async () => {
    let failOpen: (reason: string) => void = () => {}
    let opens = 0
    mockSidecar({
      'chat.open': (params) => ++opens === 1
        ? new Promise((_, reject) => (failOpen = reject))
        : Promise.resolve(view(String(params.project), {
          entries: [{ id: 1, kind: 'assistant', text: 'The clip is ready.', calls: [] }],
        })),
    })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    fireEvent.click(await sidebar.findByText('Project B'))
    await screen.findByRole('banner')
    fireEvent.click(sidebar.getByText('Project B'))
    expect(sidecarCalls('chat.open')).toHaveLength(1)

    await act(async () => failOpen('The chat could not be loaded.'))
    expect((await screen.findByRole('alert')).textContent).toContain('The chat could not be loaded.')
    fireEvent.click(sidebar.getByText('Project B'))
    expect(sidecarCalls('chat.open')).toHaveLength(2)
    expect(await screen.findByText('The clip is ready.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the running chat visible when reopening the same project', async () => {
    mockSidecar({ 'chat.open': (params) => Promise.resolve(view(String(params.project), {
      entries: [{ id: 1, kind: 'assistant', text: 'Making the clip.', calls: [] }], running: true,
    })) })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    fireEvent.click(await sidebar.findByText('Project B'))
    await screen.findByTestId('working')
    fireEvent.click(sidebar.getByText('Project B'))
    expect(screen.getByTestId('working')).toBeTruthy()
    expect(screen.getByText('Making the clip.')).toBeTruthy()
    await emit({ type: 'chat', ...view(projectB.id, {
      entries: [{ id: 2, kind: 'assistant', text: 'The clip is ready.', calls: [] }], seq: 2,
    }) })
    expect(screen.queryByTestId('working')).toBeNull()
    expect(screen.getByText('The clip is ready.')).toBeTruthy()
  })

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
    const send = held()
    mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    await screen.findByText('Project B')

    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toEqual([{ key: 'new', rev: expect.any(Number) }]))
    fireEvent.click(screen.getByText('Project B'))
    await screen.findByRole('banner')
    type('draft for B')

    await send.release()
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    await waitFor(() => expect(sidebar.getByText('A clip for my desk')).toBeTruthy())
    expect(screen.getByRole('banner').textContent).toBe('Project B')
    expect(prompt().value).toBe('draft for B')
  })

  it("keeps a slow send's failure with the project it was sent to, and sending again names the same revision", async () => {
    let failSend: (reason: string) => void = () => {}
    let tries = 0
    mockSidecar({ 'chat.send': (_, real) => (++tries === 1 ? new Promise((_, reject) => (failSend = reject)) : real()) }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))

    await act(async () => failSend(LOST))
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByText('Project A'))
    expect((await screen.findByRole('alert')).textContent).toContain('The engine restarted before it answered.')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(2))
    const [first, second] = sends()
    expect(second).toEqual(first)
    expect(saves()).toHaveLength(1)
    // The send went through this time, so its failure is no longer shown.
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('keeps a project made while the saved state was still on its way', async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)) })
    render(<StudioApp />)
    type('A clip for my desk')
    await waitFor(() => expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('A clip for my desk'))
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
    await waitFor(() => expect(prompt().value).toBe('make it red'))
    type('make it blue')
    await waitFor(() => expect(saves()).toEqual([{ key: projectB.id, text: 'make it blue', attachments: [] }]))
  })

  it('sends again after a lost answer under the same revision, with no new save', async () => {
    const store = mockSidecar({ 'chat.send': lostOnce() })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    await drop(['/Users/me/photo.jpg'])
    type('A clip like this')
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(2))
    const [first, second] = sends()
    expect(second).toEqual(first)
    expect(saves()).toEqual([{ key: projectB.id, text: 'A clip like this', attachments: ['/Users/me/photo.jpg'] }])
    expect(store.sent).toEqual([{ project: projectB.id, rev: first?.rev, text: 'A clip like this', attachments: ['/Users/me/photo.jpg'] }])
  })

  it("keeps a draft's pictures, and brings them back when the project opens again", async () => {
    mockSidecar()
    const first = render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    await drop(['/Users/me/photo.jpg'])
    await waitFor(() => expect(last(saves())).toEqual({ key: projectB.id, text: '', attachments: ['/Users/me/photo.jpg'] }))
    first.unmount()

    mockSidecar({}, [projectB], { [projectB.id]: { text: 'like this', attachments: ['/Users/me/photo.jpg'] } })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    expect(prompt().value).toBe('like this')
    expect(screen.getByTestId('attachments').textContent).toContain('photo.jpg')
  })

  it('saves the text still waiting to be saved when the app quits, then says it is done', async () => {
    mockSidecar()
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('half a thought')
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    await waitFor(() => expect(invokeMock.mock.calls.some(([command]) => command === 'studio_flushed')).toBe(true))
    expect(saves()).toEqual([{ key: projectB.id, text: 'half a thought', attachments: [] }])
  })

  it('keeps Send off until the agent can run, and names the fix', async () => {
    let needs: unknown[] = [{ kind: 'uv', fix: 'Install uv, then check again.' }]
    mockSidecar({ 'setup.check': () => Promise.resolve(needs) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    expect((await screen.findByTestId('readiness')).textContent).toContain('Install uv, then check again.')
    type('A clip')
    expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(true)
    needs = []
    fireEvent.click(screen.getByText('Check again'))
    await waitFor(() => expect(screen.queryByTestId('readiness')).toBeNull())
    expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(false)
  })

  it('asks for the sign-in a provider needs before a send, and checks again once it is done', async () => {
    let needs: unknown[] = [{ kind: 'login', provider: 'anthropic', name: 'Anthropic', fix: 'Sign in to Anthropic before you send.' }]
    mockSidecar({ 'setup.check': () => Promise.resolve(needs) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    const notice = await screen.findByTestId('readiness')
    expect(notice.textContent).toContain('Sign in to Anthropic before you send.')
    expect(screen.getByLabelText('API key or token')).toBeTruthy()
    needs = []
    await emit({ type: 'login', provider: 'anthropic', step: 'done' })
    await waitFor(() => expect(screen.queryByTestId('readiness')).toBeNull())
  })

  it('says when macOS keeps the old chats from the app, and imports them once the person allows it', async () => {
    let blocked: string | null = '/Users/me/Documents/Materialize 3D'
    mockSidecar({
      'state.get': () => Promise.resolve({ setup: { step: 'ready', done: true }, settings, projects: blocked === null ? [projectA, projectB] : [projectB], drafts: {}, importBlocked: blocked }),
      'legacy.import': () => {
        blocked = null
        return Promise.resolve({ imported: 1, blocked: null })
      },
    })
    render(<StudioApp />)
    expect((await screen.findByTestId('import-blocked')).textContent).toContain('Documents')
    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(screen.queryByTestId('import-blocked')).toBeNull())
    expect(await screen.findByText('Project A')).toBeTruthy()
  })

  it('checks again when the engine is ready, so a check that failed during a restart does not keep Send off', async () => {
    let checks = 0
    mockSidecar({ 'setup.check': () => (++checks === 1 ? Promise.reject('The engine restarted before it answered.') : Promise.resolve([])) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('A clip')
    expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(true)
    await emit({ type: 'ready', version: '1.2.3' })
    await waitFor(() => expect((screen.getByTestId('send') as HTMLButtonElement).disabled).toBe(false))
  })

  it('never brings a sent picture back in the next draft', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    await drop(['/Users/me/photo.jpg'])
    type('Like this')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('And thinner')
    await send.release()
    await pause(500)
    expect(last(saves())).toEqual({ key: projectB.id, text: 'And thinner', attachments: [] })
    fireEvent.click(screen.getByText('Project A'))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    expect(screen.queryByTestId('attachments')).toBeNull()
  })

  it('keeps a pasted picture on the screen it was pasted on, even when the person leaves before it is kept', async () => {
    let finishPicture: (path: unknown) => void = () => {}
    mockSidecar({ 'drafts.picture': () => new Promise((resolve) => (finishPicture = resolve)) }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    const file = new File(['png'], 'shot.png', { type: 'image/png' })
    fireEvent.paste(prompt(), { clipboardData: { files: [file] } })
    await waitFor(() => expect(sidecarCalls('drafts.picture')).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    await act(async () => finishPicture('/state/pictures/1/shot.png'))
    expect(screen.queryByTestId('attachments')).toBeNull()
    // It lands in the draft of the screen it was pasted on, and is there when the person goes back.
    await waitFor(() => expect(saves()).toContainEqual({ key: projectA.id, text: '', attachments: ['/state/pictures/1/shot.png'] }))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(screen.getByLabelText('Remove shot.png')).toBeTruthy())
  })

  it('keeps a paste that lands after the person left in that screen\'s draft, beside the text typed there', async () => {
    let finishPicture: (path: unknown) => void = () => {}
    mockSidecar({ 'drafts.picture': () => new Promise((resolve) => (finishPicture = resolve)) }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    type('like this')
    fireEvent.paste(prompt(), { clipboardData: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } })
    await waitFor(() => expect(sidecarCalls('drafts.picture')).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    await act(async () => finishPicture('/state/pictures/1/shot.png'))
    await waitFor(() => expect(last(saves(projectA.id))).toEqual({ key: projectA.id, text: 'like this', attachments: ['/state/pictures/1/shot.png'] }))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(screen.getByLabelText('Remove shot.png')).toBeTruthy())
    expect(prompt().value).toBe('like this')
  })

  it("brings the start screen's saved pictures back even when the person typed before the saved state arrived", async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)) })
    render(<StudioApp />)
    type('a hook')
    await act(async () =>
      finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: { new: { text: 'older', attachments: ['/Users/me/hook.jpg'], rev: 1 } }, importBlocked: null }),
    )
    expect(screen.getByTestId('attachments').textContent).toContain('hook.jpg')
    expect(prompt().value).toBe('a hook')
    await waitFor(() => expect(last(saves())).toEqual({ key: 'new', text: 'a hook', attachments: ['/Users/me/hook.jpg'] }))
  })

  it("leaves another project's same picture alone when a send goes through", async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    await drop(['/Users/me/photo.jpg'])
    type('Like this')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    await drop(['/Users/me/photo.jpg'])
    await send.release()
    await pause(500)
    expect(last(saves(projectB.id))).toEqual({ key: projectB.id, text: '', attachments: ['/Users/me/photo.jpg'] })
  })

  it('keeps a newer saved draft that reads the same as the sent text', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('Make it blue')
    type('Make it red')
    await drop(['/Users/me/new.jpg'])
    await pause(500)
    await send.release()
    fireEvent.click(screen.getByText('Project A'))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    expect(prompt().value).toBe('Make it red')
    expect(screen.getByTestId('attachments').textContent).toContain('new.jpg')
  })

  it('keeps a paste on its screen even when the person leaves while its bytes are read', async () => {
    mockSidecar({ 'drafts.picture': () => Promise.resolve('/state/pictures/1/shot.png') }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    let finishRead: (bytes: ArrayBuffer) => void = () => {}
    const file = new File(['png'], 'shot.png', { type: 'image/png' })
    file.arrayBuffer = () => new Promise((resolve) => (finishRead = resolve))
    fireEvent.paste(prompt(), { clipboardData: { files: [file] } })
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    await act(async () => finishRead(new ArrayBuffer(3)))
    await pause(50)
    expect(screen.queryByTestId('attachments')).toBeNull()
  })

  it("brings the start screen's saved pictures back when the person typed and paused before the saved state arrived", async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)) })
    render(<StudioApp />)
    type('a hook')
    await pause(500)
    await act(async () =>
      finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: { new: { text: 'older', attachments: ['/Users/me/hook.jpg'], rev: 1 } }, importBlocked: null }),
    )
    expect(screen.getByTestId('attachments').textContent).toContain('hook.jpg')
    await waitFor(() => expect(last(saves())).toEqual({ key: 'new', text: 'a hook', attachments: ['/Users/me/hook.jpg'] }))
  })

  it('takes the sent pictures out of the composer when the person left and came back before the send went through', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    await drop(['/Users/me/photo.jpg'])
    type('Like this')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    await send.release()
    expect(screen.queryByTestId('attachments')).toBeNull()
  })

  it('sends the revision the draft was saved as, and names nothing else', async () => {
    mockSidecar()
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    expect(sends()).toEqual([{ key: projectB.id, rev: draftRevs }])
  })

  it('keeps the composer and the saved draft the same when a picture was added during a send', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    await drop(['/Users/me/new.jpg'])
    await pause(500)
    await send.release()
    const shown = { text: prompt().value, pictures: screen.getByTestId('attachments').textContent }
    fireEvent.click(screen.getByText('Project A'))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    expect({ text: prompt().value, pictures: screen.getByTestId('attachments').textContent }).toEqual(shown)
  })

  it('clears a picture-only first message from the start screen the person went back to', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    await screen.findByText('Project B')
    await drop(['/Users/me/photo.jpg'])
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    fireEvent.click(screen.getByTestId('new-project'))
    await send.release()
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('New part'))
    fireEvent.click(screen.getByTestId('new-project'))
    expect(screen.queryByTestId('attachments')).toBeNull()
  })

  // The cases of #205: each is a way a window that named its own messages sent one twice, took a new one for an old
  // one, or lost or kept a draft by mistake.

  it('sends pictures restored by moving away and back as the same message: the same revision, with no new save', async () => {
    const store = mockSidecar({ 'chat.send': lostOnce() }, [projectA, projectB], {
      [projectA.id]: { text: 'A clip like this', attachments: ['/Users/me/pic.jpg'], rev: 7 },
    })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(prompt().value).toBe('A clip like this'))
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(prompt().value).toBe('A clip like this'))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(2))
    expect(sends()).toEqual([
      { key: projectA.id, rev: 7 },
      { key: projectA.id, rev: 7 },
    ])
    expect(saves()).toEqual([])
    expect(store.sent).toHaveLength(1)
  })

  it('leaves no draft in the store when the person left the start screen before its first send finished', async () => {
    const send = held()
    const store = mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    await send.release()
    await pause(500)
    expect(store.drafts).toEqual({})
    expect(saves('new')).toEqual([{ key: 'new', text: 'A clip', attachments: [] }])
    fireEvent.click(screen.getByTestId('new-project'))
    expect(prompt().value).toBe('')
  })

  it('sends a picture taken out and put back as a new message, under a new revision', async () => {
    mockSidecar({ 'chat.send': lostOnce() }, [projectA, projectB], { [projectA.id]: { text: 'A clip like this', attachments: ['/Users/me/pic.jpg'], rev: 7 } })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(prompt().value).toBe('A clip like this'))
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByLabelText('Remove pic.jpg'))
    await drop(['/Users/me/pic.jpg'])
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(2))
    expect(last(saves())).toEqual({ key: projectA.id, text: 'A clip like this', attachments: ['/Users/me/pic.jpg'] })
    expect(sends()[1]).toEqual({ key: projectA.id, rev: draftRevs })
    expect(draftRevs).not.toBe(7)
  })

  it('fails a send whose draft save fails, and sends nothing under the older revision', async () => {
    let tries = 0
    mockSidecar(
      { 'chat.send': lostOnce(), 'drafts.set': (_, real) => (++tries === 2 || tries === 3 ? Promise.reject('The engine is starting.') : real()) },
      [projectA, projectB],
    )
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    type('A clip for my shelf')
    // The pause after typing saves the change, and that save fails. So does the one the send makes.
    await waitFor(() => expect(saves()).toHaveLength(2))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(saves()).toHaveLength(3))
    await pause(50)
    expect(sends()).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('The engine is starting.')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(2))
    expect(last(saves())).toEqual({ key: projectA.id, text: 'A clip for my shelf', attachments: [] })
    expect(sends()[1]).toEqual({ key: projectA.id, rev: draftRevs })
  })

  it('keeps a start draft changed while its first send runs as a newer draft, exactly as it is, and never sends it', async () => {
    const send = held()
    const store = mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    await screen.findByText('Project B')
    await drop(['/Users/me/photo.jpg'])
    type('A clip')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('A hook')
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    expect(saves('new')).toEqual([{ key: 'new', text: 'A clip', attachments: ['/Users/me/photo.jpg'] }])
    await send.release()
    await waitFor(() => expect(store.drafts.new).toMatchObject({ text: 'A hook', attachments: ['/Users/me/photo.jpg'] }))
    expect(store.drafts.new?.rev).toBeGreaterThan(Number(sends()[0]?.rev))
    expect(sends()).toHaveLength(1)
    expect(store.sent.map((message) => message.text)).toEqual(['A clip'])
    expect(Object.keys(store.drafts)).toEqual(['new'])
    fireEvent.click(screen.getByTestId('new-project'))
    expect(prompt().value).toBe('A hook')
    expect(screen.getByTestId('attachments').textContent).toContain('photo.jpg')
  })

  it('sends a picture-only first message again after a lost answer to the same project, once', async () => {
    const store = mockSidecar({ 'chat.send': lostOnce() })
    render(<StudioApp />)
    await screen.findByText('Project B')
    await drop(['/Users/me/pic.jpg'])
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByText('Project B'))
    fireEvent.click(screen.getByTestId('new-project'))
    await waitFor(() => expect(screen.getByTestId('attachments').textContent).toContain('pic.jpg'))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(2))
    const [first, second] = sends()
    expect(second).toEqual(first)
    expect(saves()).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('New part'))
    expect(store.projects.filter((p) => p.title === 'New part')).toHaveLength(1)
    expect(store.sent).toHaveLength(1)
  })

  it('never saves one screen twice at once when Send comes while an autosave is on its way, and sends an unchanged message once', async () => {
    const save = held()
    const store = mockSidecar({ 'drafts.set': save.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    await waitFor(() => expect(saves()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('send'))
    await pause(50)
    expect(saves()).toHaveLength(1)
    await save.release()
    await waitFor(() => expect(sends()).toEqual([{ key: projectB.id, rev: draftRevs }]))
    await pause(500)
    expect(saves()).toHaveLength(1)
    expect(store.sent).toHaveLength(1)
  })

  it('sends the message the person clicked Send on, even when they type more while an earlier autosave is still on its way', async () => {
    let releaseFirst: () => void = () => {}
    let calls = 0
    const store = mockSidecar(
      {
        'drafts.set': (_, real) => (++calls === 1 ? new Promise((resolve) => (releaseFirst = () => resolve(real()))) : real()),
      },
      [projectA, projectB],
    )
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    await waitFor(() => expect(saves()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('send'))
    type('Make it blue')
    await act(async () => releaseFirst())
    await waitFor(() => expect(store.sent).toHaveLength(1))
    expect(store.sent[0]).toMatchObject({ text: 'Make it red' })
    // The text typed after the click is the next message: it stays in the composer, and in the store.
    await pause(600)
    expect(prompt().value).toBe('Make it blue')
    expect(store.drafts[projectB.id]).toMatchObject({ text: 'Make it blue' })
  })

  it('sends pictures restored from a late saved state under a new revision, never as a repeat of a sent one', async () => {
    let finishState: (state: unknown) => void = () => {}
    const store = mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)), 'chat.send': lostOnce() })
    render(<StudioApp />)
    type('a hook')
    await pause(500)
    fireEvent.click(screen.getByTestId('send'))
    await screen.findByRole('alert')
    await act(async () =>
      finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: { new: { text: 'older', attachments: ['/Users/me/hook.jpg'], rev: 1 } }, importBlocked: null }),
    )
    expect(screen.getByTestId('attachments').textContent).toContain('hook.jpg')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(2))
    const [first, second] = sends()
    expect(second?.rev).not.toBe(first?.rev)
    expect(last(saves('new'))).toEqual({ key: 'new', text: 'a hook', attachments: ['/Users/me/hook.jpg'] })
    expect(last(store.sent)).toMatchObject({ rev: second?.rev, attachments: ['/Users/me/hook.jpg'] })
  })

  it('takes a picture-only first message to its project and leaves the start screen empty, after a relaunch too', async () => {
    const store = mockSidecar()
    const first = render(<StudioApp />)
    await screen.findByText('Project B')
    await drop(['/Users/me/photo.jpg'])
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('New part'))
    expect(screen.queryByTestId('attachments')).toBeNull()
    fireEvent.click(screen.getByTestId('new-project'))
    expect(screen.queryByTestId('attachments')).toBeNull()
    await pause(500)
    expect(store.drafts).toEqual({})
    first.unmount()

    mockSidecar({}, store.projects, store.drafts)
    render(<StudioApp />)
    await screen.findByText('New part')
    expect(screen.queryByTestId('attachments')).toBeNull()
    expect(prompt().value).toBe('')
  })

  it('brings back an unsent start picture from a first saved state that arrives after a text send', async () => {
    let answerState: () => void = () => {}
    const store = mockSidecar(
      {
        'state.get': (_, real) => {
          const before = real()
          return new Promise((resolve) => (answerState = () => resolve(before)))
        },
      },
      [projectB],
      { new: { text: '', attachments: ['/Users/me/a.jpg'] } },
    )
    render(<StudioApp />)
    await screen.findByText('Engine 1.2.3')
    type('A clip')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(store.sent).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('A clip'))
    await act(async () => answerState())
    fireEvent.click(screen.getByTestId('new-project'))
    // a.jpg was saved on the start screen but never shown or sent, so it is still the start screen's.
    await waitFor(() => expect(screen.getByTestId('attachments').textContent).toContain('a.jpg'))
  })

  it('never brings back a sent start picture from a saved state that was read before the send', async () => {
    let reads = 0
    let answerLate: () => void = () => {}
    const store = mockSidecar(
      {
        'state.get': (_, real) => {
          // macOS keeps the old chats from the app at first, so the window offers to import them again.
          if (++reads === 1) return real().then((state) => ({ ...(state as object), importBlocked: '/Users/me/Documents/Materialize 3D' }))
          if (reads !== 2) return real()
          // The state the import retry reads now, answered only after the send went through.
          const before = real()
          return new Promise((resolve) => (answerLate = () => resolve(before)))
        },
        'legacy.import': () => Promise.resolve({ imported: 0, blocked: null }),
      },
      [projectB],
      { new: { text: '', attachments: ['/Users/me/pic.jpg'] } },
    )
    render(<StudioApp />)
    await waitFor(() => expect(screen.getByTestId('attachments').textContent).toContain('pic.jpg'))
    fireEvent.click(await screen.findByText('Try again'))
    await waitFor(() => expect(reads).toBe(2))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(store.sent).toHaveLength(1))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('New part'))
    await act(async () => answerLate())
    await pause(500)
    expect(store.drafts.new).toBeUndefined()
    fireEvent.click(screen.getByTestId('new-project'))
    expect(screen.queryByTestId('attachments')).toBeNull()
  })

  it('saves every screen before a quit goes on, retrying a save the engine restart refused once the engine is back', async () => {
    let engineBack = false
    let releaseB: () => void = () => {}
    const store = mockSidecar(
      {
        'drafts.set': (params, real) => {
          if (params.key === projectA.id && !engineBack) return Promise.reject('The engine restarted before it answered. Try again.')
          if (params.key === projectB.id) return new Promise((resolve) => (releaseB = () => resolve(real())))
          return real()
        },
      },
      [projectA, projectB],
    )
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('a hook')
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    type('a shelf')
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    await act(async () => releaseB())
    await pause(50)
    const said = (command: string) => invokeMock.mock.calls.some(([name]) => name === command)
    expect(said('studio_flushed')).toBe(false)
    engineBack = true
    await emit({ type: 'ready', version: '1.2.3' })
    await waitFor(() => expect(said('studio_flushed')).toBe(true))
    expect(store.drafts[projectA.id]).toMatchObject({ text: 'a hook' })
    expect(store.drafts[projectB.id]).toMatchObject({ text: 'a shelf' })
  })

  it('saves text typed during a send that started while a quit waited to retry, before the quit goes on', async () => {
    let engineBack = false
    const sending = held()
    const store = mockSidecar(
      {
        'drafts.set': (_, real) => (engineBack ? real() : Promise.reject('The engine restarted before it answered. Try again.')),
        'chat.send': sending.call,
      },
      [projectA, projectB],
    )
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('a hook')
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    await pause(50)
    // The engine is back before its ready event reaches the window. The person sends, then types the next message.
    engineBack = true
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('a hook, in black')
    await emit({ type: 'ready', version: '1.2.3' })
    await pause(50)
    const said = (command: string) => invokeMock.mock.calls.some(([name]) => name === command)
    expect(said('studio_flushed')).toBe(false)
    await sending.release()
    await waitFor(() => expect(said('studio_flushed')).toBe(true))
    expect(store.drafts[projectA.id]).toMatchObject({ text: 'a hook, in black' })
  })

  it('saves text typed during a send clicked while the quit waited for a save already on its way', async () => {
    let releaseSave: () => void = () => {}
    let saves = 0
    const sending = held()
    const store = mockSidecar(
      {
        'drafts.set': (_, real) => (++saves === 1 ? new Promise((resolve) => (releaseSave = () => resolve(real()))) : real()),
        'chat.send': sending.call,
      },
      [projectA, projectB],
    )
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('a hook')
    // The pause after typing starts the save, and the quit comes while it is on its way.
    await waitFor(() => expect(sidecarCalls('drafts.set')).toHaveLength(1))
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    fireEvent.click(screen.getByTestId('send'))
    type('a hook, in black')
    await act(async () => releaseSave())
    await pause(50)
    const said = (command: string) => invokeMock.mock.calls.some(([name]) => name === command)
    expect(said('studio_flushed')).toBe(false)
    await sending.release()
    await waitFor(() => expect(said('studio_flushed')).toBe(true))
    expect(store.drafts[projectA.id]).toMatchObject({ text: 'a hook, in black' })
  })

  it('keeps the app open and says why when a draft still cannot be saved at a quit', async () => {
    mockSidecar(
      { 'drafts.set': (params, real) => (params.key === projectA.id ? Promise.reject('The engine stopped.') : real()) },
      [projectA, projectB],
    )
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('a hook')
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    const said = (command: string) => invokeMock.mock.calls.some(([name]) => name === command)
    await waitFor(() => expect(said('studio_flush_failed')).toBe(true), { timeout: 15_000 })
    expect(said('studio_flushed')).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain('could not be saved')
  }, 20_000)

  it('waits for a pasted picture still being kept before it says a quit may go on, and saves it with the draft', async () => {
    let keep: () => void = () => {}
    const store = mockSidecar({ 'drafts.picture': () => new Promise((resolve) => (keep = () => resolve('/state/pictures/1/shot.png'))) }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    fireEvent.paste(prompt(), { clipboardData: { files: [new File(['png'], 'shot.png', { type: 'image/png' })] } })
    await waitFor(() => expect(sidecarCalls('drafts.picture')).toHaveLength(1))
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    await pause(50)
    const flushed = () => invokeMock.mock.calls.some(([command]) => command === 'studio_flushed')
    expect(flushed()).toBe(false)
    await act(async () => keep())
    await waitFor(() => expect(flushed()).toBe(true))
    expect(store.drafts[projectA.id]).toMatchObject({ attachments: ['/state/pictures/1/shot.png'] })
  })

  it('saves the draft a first send made for its project during a quit before it says the quit may go on', async () => {
    const sending = held()
    const store = mockSidecar({ 'chat.send': sending.call })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A knob')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('A knob, and a dial')
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    await sending.release()
    const flushed = () => invokeMock.mock.calls.some(([command]) => command === 'studio_flushed')
    await waitFor(() => expect(flushed()).toBe(true))
    const project = store.projects.find((p) => p.title === 'A knob')
    expect(project).toBeDefined()
    expect(store.drafts[project?.id ?? '']).toMatchObject({ text: 'A knob, and a dial' })
  })

  it('tells Rust at once that it is saving when a quit asks, so Rust holds the quit until the window is done', async () => {
    const save = held()
    mockSidecar({ 'drafts.set': save.call })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('half a thought')
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    const said = (command: string) => invokeMock.mock.calls.some(([name]) => name === command)
    expect(said('studio_flush_started')).toBe(true)
    expect(said('studio_flushed')).toBe(false)
    await save.release()
    await waitFor(() => expect(said('studio_flushed')).toBe(true))
  })

  it('reads the saved state again when the engine comes back, if the first read failed', async () => {
    let reads = 0
    mockSidecar({ 'state.get': (_, real) => (++reads === 1 ? Promise.reject('The engine stopped.') : real()) }, [projectA, projectB])
    render(<StudioApp />)
    await waitFor(() => expect(reads).toBe(1))
    expect(screen.queryByText('Project A')).toBeNull()
    await emit({ type: 'ready', version: '1.2.3' })
    expect(await screen.findByText('Project A')).toBeTruthy()
  })

  it('keeps a picture the person took out and put back while its send was on its way', async () => {
    const sending = held()
    mockSidecar({ 'chat.send': sending.call }, [projectA, projectB], { [projectA.id]: { text: 'A clip like this', attachments: ['/Users/me/pic.jpg'] } })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await waitFor(() => expect(prompt().value).toBe('A clip like this'))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByLabelText('Remove pic.jpg'))
    await act(async () => listeners.drop.forEach((listener) => listener({ payload: { type: 'drop', paths: ['/Users/me/pic.jpg'] } })))
    await sending.release()
    await pause(100)
    // The person chose it again, so it is part of the next message.
    expect(screen.getByTestId('attachments').textContent).toContain('pic.jpg')
  })

  it('waits for a draft save already on its way before it says a quit may go on', async () => {
    const save = held()
    mockSidecar({ 'drafts.set': save.call })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('half a thought')
    // The pause after typing starts the save, which the sidecar has not answered yet.
    await waitFor(() => expect(saves()).toHaveLength(1))
    await act(async () => listeners.flush.forEach((listener) => listener({ payload: null })))
    await pause(50)
    const flushed = () => invokeMock.mock.calls.some(([command]) => command === 'studio_flushed')
    expect(flushed()).toBe(false)
    await save.release()
    await waitFor(() => expect(flushed()).toBe(true))
  })

  it('keeps text typed while the draft before a send was still being saved, and saves it once the send is done', async () => {
    let finishSave = () => {}
    let tries = 0
    mockSidecar({ 'drafts.set': (_, real) => (++tries === 1 ? new Promise((resolve) => (finishSave = () => resolve(real()))) : real()) })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(saves()).toHaveLength(1))
    type('Make it blue')
    await pause(500)
    expect(saves()).toHaveLength(1)
    await act(async () => finishSave())
    await waitFor(() => expect(sends()).toEqual([{ key: projectB.id, rev: expect.any(Number) }]))
    await waitFor(() => expect(last(saves())).toEqual({ key: projectB.id, text: 'Make it blue', attachments: [] }))
    expect(prompt().value).toBe('Make it blue')
  })

  it("keeps a picture added while a first message was on its way, as its project's draft", async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    await drop(['/Users/me/later.jpg'])
    await send.release()
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('A clip'))
    expect(screen.getByTestId('attachments').textContent).toContain('later.jpg')
    await waitFor(() => expect(saves('2026-11-06-a-clip')).toEqual([{ key: '2026-11-06-a-clip', text: 'A clip', attachments: ['/Users/me/later.jpg'] }]))
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

  it('keeps the newer chat when an older load answers after the reload an engine restart made', async () => {
    const asked = { id: 1, kind: 'user', text: 'A clip', images: [] }
    const reply = { id: 2, kind: 'assistant', text: 'The clip is ready.', calls: [] }
    let finishFirst: (view: unknown) => void = () => {}
    let opens = 0
    mockSidecar({
      'chat.open': (params) =>
        ++opens === 1
          ? new Promise((resolve) => (finishFirst = resolve))
          : Promise.resolve(view(String(params.project), { entries: [asked, reply], running: false, seq: 5 })),
    })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    await emit({ type: 'ready', version: '1.2.3' })
    await screen.findByText('The clip is ready.')
    await act(async () => finishFirst(view(projectB.id, { entries: [asked], running: true, seq: 1 })))
    expect(screen.getByText('The clip is ready.')).toBeTruthy()
    expect(screen.queryByTestId('working')).toBeNull()
  })

  it('ignores a superseded chat load rejection after an engine reload', async () => {
    let failFirst: (reason: string) => void = () => {}
    let opens = 0
    mockSidecar({
      'chat.open': (params) => ++opens === 1
        ? new Promise((_, reject) => (failFirst = reject))
        : Promise.resolve(view(String(params.project), {
          entries: [{ id: 1, kind: 'assistant', text: 'The clip is ready.', calls: [] }],
        })),
    })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    fireEvent.click(await sidebar.findByText('Project B'))
    await screen.findByRole('banner')
    await emit({ type: 'ready', version: '1.2.3' })
    await screen.findByText('The clip is ready.')

    await act(async () => failFirst('The chat could not be loaded.'))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(sidebar.getByText('Project B'))
    expect(sidecarCalls('chat.open')).toHaveLength(2)
    expect(screen.getByText('The clip is ready.')).toBeTruthy()
  })

  it('keeps an engine recovery pending after an earlier reload failed', async () => {
    const recovery = held()
    let opens = 0
    mockSidecar({
      'chat.open': (params) => {
        const project = String(params.project)
        switch (++opens) {
          case 1:
            return Promise.resolve(view(project, { entries: [{ id: 1, kind: 'assistant', text: 'The chat is open.', calls: [] }] }))
          case 2:
            return Promise.reject('The chat could not be loaded.')
          case 3:
            return recovery.call(params, () => Promise.resolve(view(project, {
              entries: [{ id: 2, kind: 'assistant', text: 'The recovered clip is ready.', calls: [] }], seq: 3,
            })))
          default:
            return Promise.reject('An extra chat load started.')
        }
      },
    })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    fireEvent.click(await sidebar.findByText('Project B'))
    await screen.findByText('The chat is open.')
    await emit({ type: 'ready', version: '1.2.3' })
    expect((await screen.findByRole('alert')).textContent).toContain('The chat could not be loaded.')

    await emit({ type: 'ready', version: '1.2.3' })
    expect(sidecarCalls('chat.open')).toHaveLength(3)
    fireEvent.click(sidebar.getByText('Project B'))
    expect(sidecarCalls('chat.open')).toHaveLength(3)
    await recovery.release()
    expect(await screen.findByText('The recovered clip is ready.')).toBeTruthy()
  })

  it.each(['load error', 'unrelated error'])('recovers from an engine reload failure with a current %s', async (shownError) => {
    const recovery = held()
    let opens = 0
    mockSidecar({
      'chat.open': (params) => {
        const project = String(params.project)
        switch (++opens) {
          case 1:
            return Promise.resolve(view(project, { entries: [{ id: 1, kind: 'assistant', text: 'The chat is open.', calls: [] }] }))
          case 2:
            return Promise.reject('The chat could not be loaded.')
          case 3:
            return recovery.call(params, () => Promise.resolve(view(project, {
              entries: [{ id: 2, kind: 'assistant', text: 'The recovered clip is ready.', calls: [] }], seq: 3,
            })))
          default:
            return Promise.reject('An extra chat load started.')
        }
      },
    })
    render(<StudioApp />)
    const sidebar = within(screen.getByRole('navigation', { name: 'Projects' }))
    fireEvent.click(await sidebar.findByText('Project B'))
    await screen.findByText('The chat is open.')
    await emit({ type: 'ready', version: '1.2.3' })
    expect((await screen.findByRole('alert')).textContent).toContain('The chat could not be loaded.')
    await emit({ type: 'ready', version: '1.2.3' })
    if (shownError === 'unrelated error') await drop(['/Users/me/notes.txt'])

    await recovery.release()
    expect(await screen.findByText('The recovered clip is ready.')).toBeTruthy()
    if (shownError === 'load error') expect(screen.queryByRole('alert')).toBeNull()
    else expect(screen.getByRole('alert').textContent).toContain('Drop a picture:')
    fireEvent.click(sidebar.getByText('Project B'))
    expect(sidecarCalls('chat.open')).toHaveLength(3)
  })

  it("clears a sent project's saved draft even when the person typed in another project meanwhile", async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project A'))
    type('something for A')
    await send.release()
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    expect(prompt().value).toBe('')
  })

  it('keeps text typed during a send as the next message, even when it reads the same as the sent one', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('Make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('Make it blue')
    type('Make it red')
    await send.release()
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
    expect(saves()).toEqual([{ key: projectB.id, text: 'make it blue', attachments: [] }])
  })

  it('keeps text typed while a send goes through as the draft', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call }, [projectA, projectB])
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project B'))
    await screen.findByRole('banner')
    type('make it red')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('make it blue')
    await send.release()
    fireEvent.click(screen.getByText('Project A'))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(prompt().value).toBe('make it blue'))
  })

  it('keeps what the person typed on the start screen when the saved state arrives', async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)) })
    render(<StudioApp />)
    type('A clip for my desk')
    await act(async () => finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: { new: { text: 'an older draft', attachments: [], rev: 1 } } }))
    expect(prompt().value).toBe('A clip for my desk')
  })

  it('leaves the start screen empty after its message was sent', async () => {
    mockSidecar()
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip for my desk')
    await waitFor(() => expect(saves()).toEqual([{ key: 'new', text: 'A clip for my desk', attachments: [] }]))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('new-project'))
    expect(prompt().value).toBe('')
  })

  it("keeps text typed during a first send as its project's draft, and never saves it on the start screen", async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('second message')
    await pause(500)
    await send.release()
    const made = '2026-11-06-a-clip-for-my-desk'
    await waitFor(() => expect(saves(made)).toEqual([{ key: made, text: 'second message', attachments: [] }]))
    expect(saves('new')).toEqual([{ key: 'new', text: 'A clip for my desk', attachments: [] }])
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))
    fireEvent.click(screen.getByText('A clip for my desk'))
    await waitFor(() => expect(prompt().value).toBe('second message'))
  })

  it('never puts a sent message back on the start screen when text typed during it was taken back', async () => {
    const send = held()
    mockSidecar({ 'chat.send': send.call })
    render(<StudioApp />)
    await screen.findByText('Project B')
    type('A clip for my desk')
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(1))
    type('A clip for my desk, and')
    type('A clip for my desk')
    await send.release()
    await pause(600)
    expect(saves('new')).toEqual([{ key: 'new', text: 'A clip for my desk', attachments: [] }])
    fireEvent.click(screen.getByTestId('new-project'))
    expect(prompt().value).toBe('')
  })

  it('leaves the start screen empty when the person cleared it before the saved state arrived', async () => {
    let finishState: (state: unknown) => void = () => {}
    mockSidecar({ 'state.get': () => new Promise((resolve) => (finishState = resolve)) })
    render(<StudioApp />)
    type('A clip for my desk')
    type('')
    await act(async () => finishState({ setup: { step: 'ready', done: true }, settings, projects: [projectB], drafts: { new: { text: 'an older draft', attachments: [], rev: 1 } } }))
    expect(prompt().value).toBe('')
  })

  it("keeps each project's unsent message, so sending it again after another project's send names its revision", async () => {
    let tries = 0
    mockSidecar({ 'chat.send': (_, real) => (++tries === 1 ? Promise.reject(LOST) : real()) }, [projectA, projectB])
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
    await waitFor(() => expect(sends()).toHaveLength(2))
    fireEvent.click(screen.getByText('Project A'))
    await waitFor(() => expect(prompt().value).toBe('A clip for my desk'))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(sends()).toHaveLength(3))
    const [first, , third] = sends()
    expect(third).toEqual(first)
    expect(saves(projectA.id)).toHaveLength(1)
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
