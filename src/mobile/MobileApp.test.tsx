// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DeviceDraft, LinkMessage } from './remote'

const { invoke, qrText, scanner, stream } = vi.hoisted(() => ({
  invoke: vi.fn(),
  qrText: { value: null as string | Error | null },
  scanner: { checkPermissions: vi.fn(), requestPermissions: vi.fn(), scan: vi.fn(), cancel: vi.fn() },
  stream: { heard: null as ((message: LinkMessage) => void) | null },
}))
// Rust's link watcher hands the window a channel's messages. Each test says what the link does.
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class {
    constructor(heard: (message: LinkMessage) => void) {
      stream.heard = heard
    }
  },
}))
vi.mock('@tauri-apps/plugin-barcode-scanner', () => ({ Format: { QRCode: 'QR_CODE' }, ...scanner }))
// jsdom draws no pictures, so the picture's QR text is set by each test.
vi.mock('./qr', () => ({
  readQrPicture: async () => {
    if (qrText.value instanceof Error) throw qrText.value
    return qrText.value
  },
}))

import MobileApp from './MobileApp'
import { PREVIEW_LIMIT } from './remote'
import remoteRs from '../../src-mobile/src/remote.rs?raw'

const computer = { id: 'a70bf50e531ce1a8', name: 'Studio Mac', origin: 'https://studio.tail1234.ts.net:47380/' }
const link = 'https://studio.tail1234.ts.net:47380/pair?code=K7Q2'

function answer(commands: Record<string, unknown>) {
  invoke.mockImplementation(async (command: string) => commands[command])
}

const chats = () => Response.json([{ id: 'desk-clip', title: 'Desk cable clip' }])
const deskClip = {
  project: 'desk-clip',
  entries: [{ id: 1, kind: 'user', text: 'Make a clip that holds a cable on the edge of my desk.', images: [], files: [] }],
  running: false,
  waiting: null,
  turn: null,
  seq: 1,
}
/** The computer's answers by path. A path it does not list answers 404. */
const computerAnswers = (answer: () => Response, routes: Record<string, () => Response> = {}) =>
  vi.stubGlobal('fetch', async (url: string) => {
    const path = url.replace('m3dremote://localhost', '')
    if (path === '/api/v1/chats') return answer()
    return routes[path]?.() ?? new Response('Not found', { status: 404 })
  })
computerAnswers(chats)

afterEach(async () => {
  computerAnswers(chats)
  Object.values(scanner).forEach((mock) => mock.mockReset())
  cleanup()
  // A chat screen writes its draft as it closes, a tick later, so that write lands before the next test.
  await new Promise((resolve) => setTimeout(resolve, 0))
  invoke.mockReset()
  qrText.value = null
})

const choosePicture = () =>
  fireEvent.change(screen.getByTestId('picture-input'), { target: { files: [new File(['png'], 'code.png', { type: 'image/png' })] } })

describe('MobileApp', () => {
  it('pairs with the computer in a picture of its code, then lists that computer’s chats', async () => {
    answer({ paired_computer: null, pair: computer })
    render(<MobileApp />)
    await screen.findByText('Pair with your computer')

    qrText.value = link
    choosePicture()

    expect(await screen.findByText('Desk cable clip')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Studio Mac' })).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('pair', { link, device: 'iPhone' })
  })

  it('says so when a picture holds no code, and pairs with nothing', async () => {
    answer({ paired_computer: null })
    render(<MobileApp />)
    await screen.findByText('Pair with your computer')

    choosePicture()

    expect((await screen.findByRole('alert')).textContent).toBe('No pairing code was found in that picture.')
    expect(invoke).not.toHaveBeenCalledWith('pair', expect.anything())
  })

  it('opens on the paired computer’s chats after a relaunch, with no new pairing', async () => {
    answer({ paired_computer: computer })
    render(<MobileApp />)

    expect(await screen.findByText('Desk cable clip')).toBeTruthy()
    expect(screen.queryByText('Pair with your computer')).toBeNull()
  })

  it('redeems one code at a time, so a second picture during pairing pairs nothing more', async () => {
    let paired: (computer: unknown) => void = () => {}
    invoke.mockImplementation(async (command: string) => (command === 'pair' ? new Promise((resolve) => (paired = resolve)) : null))
    render(<MobileApp />)
    await screen.findByText('Pair with your computer')

    qrText.value = link
    choosePicture()
    await screen.findByText('Pairing')
    choosePicture()
    paired(computer)

    expect(await screen.findByText('Desk cable clip')).toBeTruthy()
    expect(invoke.mock.calls.filter(([command]) => command === 'pair')).toHaveLength(1)
  })

  it('offers Try again when the computer answers an error with no words', async () => {
    answer({ paired_computer: computer })
    computerAnswers(() => new Response('', { status: 503 }))
    render(<MobileApp />)
    expect(await screen.findByText(/The computer answered 503\./)).toBeTruthy()

    computerAnswers(chats)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Desk cable clip')).toBeTruthy()
  })

  it('shows why a picture could not be read, instead of saying it holds no code', async () => {
    answer({ paired_computer: null })
    render(<MobileApp />)
    await screen.findByText('Pair with your computer')

    qrText.value = new Error('This device could not read the picture.')
    choosePicture()

    expect((await screen.findByRole('alert')).textContent).toBe('This device could not read the picture.')
  })

  it('starts no scan and redeems nothing after Cancel while iOS asks for the camera', async () => {
    answer({ paired_computer: null })
    let allow: (state: string) => void = () => {}
    scanner.checkPermissions.mockReturnValue(new Promise((resolve) => (allow = resolve)))
    render(<MobileApp />)

    fireEvent.click(await screen.findByRole('button', { name: 'Scan the code' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    allow('prompt')

    expect(await screen.findByRole('button', { name: 'Scan the code' })).toBeTruthy()
    expect(scanner.scan).not.toHaveBeenCalled()
    expect(scanner.requestPermissions).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('pair', expect.anything())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the transcript when the model files fail to load', async () => {
    answerWithDrafts({ paired_computer: computer })
    computerAnswers(chats, {
      '/api/v1/chats/desk-clip': () => Response.json(deskClip),
      '/api/v1/chats/desk-clip/files': () => new Response('A folder could not be read.', { status: 500 }),
    })
    render(<MobileApp />)
    const opens = await screen.findByRole('button', { name: 'Desk cable clip' })
    // The chat reads the computer once the link is up.
    await linkIs({ kind: 'connected' })
    fireEvent.click(opens)

    expect(await screen.findByText('Make a clip that holds a cable on the edge of my desk.')).toBeTruthy()
    expect(await screen.findByText('The model files did not load. A folder could not be read.')).toBeTruthy()
  })

  it('never fetches a model the list says is too large, and opens the newest one that fits', async () => {
    answerWithDrafts({ paired_computer: computer })
    const fetched: string[] = []
    const files = [
      { rel: 'huge.stl', size: PREVIEW_LIMIT + 1, modifiedMs: 2 },
      { rel: 'clip.stl', size: 1000, modifiedMs: 1 },
    ]
    computerAnswers(chats, {
      '/api/v1/chats/desk-clip': () => Response.json(deskClip),
      '/api/v1/chats/desk-clip/files': () => Response.json(files),
    })
    const listed = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      return listed(url)
    })
    render(<MobileApp />)
    const opens = await screen.findByRole('button', { name: 'Desk cable clip' })
    // The chat reads the computer once the link is up.
    await linkIs({ kind: 'connected' })
    fireEvent.click(opens)

    expect(await screen.findByRole('button', { name: 'clip.stl', pressed: true })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'huge.stl' }))

    expect(await screen.findByText('huge.stl is too large to show on this device (over 64 MB).')).toBeTruthy()
    // jsdom has no WebGL, so a mounted viewer would never fetch: the viewer must not mount at all.
    expect(screen.queryByTestId('model-view')).toBeNull()
    expect(fetched.filter((url) => url.endsWith('/files/huge.stl'))).toEqual([])
  })

  it('refuses the same answer size in Rust as the window does', () => {
    expect(remoteRs).toContain(`const ANSWER_LIMIT: usize = ${PREVIEW_LIMIT / (1024 * 1024)} * 1024 * 1024;`)
  })

  it('stops the model download in Rust whenever its viewer goes away: a too-large file, then leaving the chat', async () => {
    answer({ paired_computer: computer })
    const files = [
      { rel: 'clip.stl', size: 1000, modifiedMs: 2 },
      { rel: 'huge.stl', size: PREVIEW_LIMIT + 1, modifiedMs: 1 },
    ]
    computerAnswers(chats, {
      '/api/v1/chats/desk-clip': () => Response.json(deskClip),
      '/api/v1/chats/desk-clip/files': () => Response.json(files),
    })
    const stops = () => invoke.mock.calls.filter(([command]) => command === 'stop_model_reads').length
    render(<MobileApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Desk cable clip' }))
    expect(await screen.findByTestId('model-view')).toBeTruthy()
    expect(stops()).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'huge.stl' }))
    await screen.findByText('huge.stl is too large to show on this device (over 64 MB).')
    expect(stops()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'clip.stl' }))
    expect(await screen.findByTestId('model-view')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }))
    expect(await screen.findByRole('button', { name: 'Desk cable clip' })).toBeTruthy()
    expect(stops()).toBe(2)
  })

  it('shows a chat made on the computer meanwhile, after a chat and after Refresh', async () => {
    answer({ paired_computer: computer })
    let listed = [{ id: 'desk-clip', title: 'Desk cable clip' }]
    computerAnswers(() => Response.json(listed), { '/api/v1/chats/desk-clip': () => Response.json(deskClip) })
    render(<MobileApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Desk cable clip' }))
    await screen.findByText('Make a clip that holds a cable on the edge of my desk.')

    listed = [{ id: 'hook', title: 'Wall hook' }, ...listed]
    fireEvent.click(screen.getByRole('button', { name: 'Chats' }))
    expect(await screen.findByRole('button', { name: 'Wall hook' })).toBeTruthy()

    listed = [{ id: 'stand', title: 'Phone stand' }, ...listed]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('button', { name: 'Phone stand' })).toBeTruthy()
  })

  it('keeps the refreshed list when an earlier, slower read answers last', async () => {
    answer({ paired_computer: computer })
    let first: (response: Response) => void = () => {}
    let reads = 0
    vi.stubGlobal('fetch', (url: string) => {
      if (!url.endsWith('/api/v1/chats')) return Promise.resolve(new Response('Not found', { status: 404 }))
      reads += 1
      if (reads === 1) return new Promise<Response>((resolve) => (first = resolve))
      return Promise.resolve(Response.json([{ id: 'hook', title: 'Wall hook' }]))
    })
    render(<MobileApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('button', { name: 'Wall hook' })).toBeTruthy()

    first(Response.json([{ id: 'desk-clip', title: 'Desk cable clip' }]))
    await new Promise((settle) => setTimeout(settle, 50))
    expect(screen.getByRole('button', { name: 'Wall hook' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Desk cable clip' })).toBeNull()
  })

  it('opens the photo chooser from a real button, which pairing in progress disables', async () => {
    answer({ paired_computer: null })
    const opened = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    render(<MobileApp />)

    const button = await screen.findByRole('button', { name: 'Choose a picture of the code' })
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(button)
    expect(opened).toHaveBeenCalledTimes(1)
    opened.mockRestore()

    invoke.mockImplementation(async (command: string) => (command === 'pair' ? new Promise(() => {}) : null))
    qrText.value = link
    choosePicture()
    await screen.findByText('Pairing')
    expect((screen.getByRole('button', { name: 'Choose a picture of the code' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

/** The drafts this device keeps, by chat, as Rust's draft files hold them across launches. */
const kept = new Map<string, DeviceDraft>()
/** Rust's answer to a draft load, when it cannot read the file, and to a draft save, when it cannot write it or the test holds it. */
const device = { loadFails: null as string | null, saveFails: null as string | null, saveWaits: null as Promise<void> | null, forgetFails: null as string | null }

/** Holds the next draft write until the returned function lets it go. */
function holdSave(): () => void {
  let release = () => {}
  device.saveWaits = new Promise<void>((resolve) => (release = resolve))
  return () => release()
}

function answerWithDrafts(commands: Record<string, unknown>) {
  invoke.mockImplementation(async (command: string, args: { project: string; draft: DeviceDraft }) => {
    if (command === 'draft_load') {
      if (device.loadFails !== null) throw device.loadFails
      return kept.get(args.project) ?? null
    }
    if (command === 'draft_save') {
      const waits = device.saveWaits
      device.saveWaits = null
      await waits
      if (device.saveFails !== null) throw device.saveFails
      const empty = args.draft.text === '' && args.draft.pictures.length === 0 && args.draft.sent === null
      if (empty) kept.delete(args.project)
      else kept.set(args.project, args.draft)
      return
    }
    // Rust removes every draft when the device forgets its computer.
    if (command === 'forget') {
      if (device.forgetFails !== null) throw device.forgetFails
      return kept.clear()
    }
    return commands[command]
  })
}

/** The computer as the window reaches it through `m3dremote://`. `reach` false answers 502, as Rust does when it cannot reach the computer. */
const computerSide = {
  reach: true,
  requests: [] as string[],
  /** The revision the computer's last draft save got. Each save gets the next one. */
  rev: 40,
  /** The revision of each send that reached the computer, in order. */
  sent: [] as number[],
  /** How the computer meets the next send: whether it commits it, and what the device hears back. */
  nextSend: null as { commits: boolean; answer: () => Response } | null,
  /** What the device hears when it settles a send, in place of the computer's answer. */
  settleAnswer: null as (() => Response) | null,
  accepted: new Set<number>(),
  /** The revisions a settle took away, which the computer then refuses to send. */
  retired: new Set<number>(),
  list: [{ id: 'desk-clip', title: 'Desk cable clip' }],
  chat: { project: 'desk-clip', entries: [] as unknown[], running: false, waiting: null, turn: null as unknown, seq: 1 },
  /** Requests, as `METHOD /path`, the computer answers only once the test lets them go. */
  waits: new Map<string, Promise<void>>(),
}
const CHAT = 'm3dremote://localhost/api/v1/chats/desk-clip'
const view = { project: 'desk-clip', entries: [], running: false, waiting: null, turn: null, seq: 1 }

/** Holds the next `request` until the returned function lets it go. */
function hold(request: string): () => void {
  let release = () => {}
  computerSide.waits.set(request, new Promise<void>((resolve) => (release = resolve)))
  return () => release()
}

/** The answer the device gets when the link drops mid-request. */
const lost = () => {
  computerSide.reach = false
  return new Response('The computer did not answer. connection closed', { status: 502 })
}

const routeComputer = async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? 'GET'
  const request = `${method} ${url.replace('m3dremote://localhost/api/v1', '')}`
  computerSide.requests.push(request)
  const waiting = computerSide.waits.get(request)
  computerSide.waits.delete(request)
  await waiting
  if (!computerSide.reach) return new Response('The computer did not answer.', { status: 502 })
  if (url === 'm3dremote://localhost/api/v1/chats') return Response.json(computerSide.list)
  if (url === CHAT) return Response.json(computerSide.chat)
  if (url === `${CHAT}/files`) return Response.json([])
  if (url === `${CHAT}/draft` && method === 'PUT') return Response.json({ rev: ++computerSide.rev })
  if (url === `${CHAT}/send` && method === 'POST') {
    const { rev } = JSON.parse(init?.body ?? '{}') as { rev: number }
    computerSide.sent.push(rev)
    if (computerSide.retired.has(rev)) return Response.json({ error: 'The draft changed before it went out. Send it again.' }, { status: 409 })
    const meet = computerSide.nextSend
    computerSide.nextSend = null
    if (meet?.commits !== false) computerSide.accepted.add(rev)
    return meet === null ? Response.json({ project: { id: 'desk-clip' } }) : meet.answer()
  }
  const settling = /\/sends\/(\d+)\/settle$/.exec(url)
  if (settling && method === 'POST') {
    if (computerSide.settleAnswer !== null) return computerSide.settleAnswer()
    const rev = Number(settling[1])
    if (!computerSide.accepted.has(rev)) computerSide.retired.add(rev)
    return Response.json({ accepted: computerSide.accepted.has(rev) })
  }
  return new Response('Not found', { status: 404 })
}

const linkIs = (message: LinkMessage) => act(() => stream.heard?.(message))
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' })
const messageBox = () => screen.getByLabelText<HTMLTextAreaElement>('Message')
const settles = () => computerSide.requests.filter((r) => r === 'POST /chats/desk-clip/sends/41/settle').length
/** Longer than any wait a send could take before it asks the computer again by itself. */
const quietSpell = () => new Promise((resolve) => setTimeout(resolve, 2_100))
const writes = () => computerSide.requests.filter((r) => r.startsWith('PUT') || r.startsWith('POST'))
const puts = () => writes().filter((r) => r.startsWith('PUT'))
const backToChats = () => fireEvent.click(screen.getByRole('button', { name: 'Chats' }))
const reopen = async () => {
  fireEvent.click(await screen.findByText('Desk cable clip'))
  return screen.findByLabelText<HTMLTextAreaElement>('Message')
}

/** Opens the chat on a paired device. The chat list from an earlier launch lets it open while the computer is away. */
async function openChat() {
  answerWithDrafts({ paired_computer: computer })
  localStorage.setItem('m3d.chats', JSON.stringify(computerSide.list))
  render(<MobileApp />)
  fireEvent.click(await screen.findByText('Desk cable clip'))
  return screen.findByLabelText<HTMLTextAreaElement>('Message')
}

/** Opens the chat with this draft kept on the device and the link up, ready to send. */
async function readyToSend(text = 'Make the clip 2 mm thicker') {
  kept.set('desk-clip', { text, pictures: [], sent: null })
  await openChat()
  await linkIs({ kind: 'connected' })
  await waitFor(() => expect(sendButton().disabled).toBe(false))
}

describe('a draft and the link to the computer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', routeComputer)
  })

  afterEach(() => {
    kept.clear()
    localStorage.clear()
    Object.assign(device, { loadFails: null, saveFails: null, saveWaits: null, forgetFails: null })
    Object.assign(computerSide, {
      reach: true,
      requests: [],
      rev: 40,
      sent: [],
      nextSend: null,
      settleAnswer: null,
      accepted: new Set(),
      retired: new Set(),
      list: [{ id: 'desk-clip', title: 'Desk cable clip' }],
      chat: view,
      waits: new Map(),
    })
  })

  it('keeps a photo and message written while the computer is away across a relaunch, with Send off', async () => {
    computerSide.reach = false
    const message = await openChat()
    await linkIs({ kind: 'offline', detail: 'The computer did not answer.' })
    fireEvent.change(message, { target: { value: 'Make the clip 2 mm thicker' } })
    fireEvent.change(screen.getByLabelText('Add a photo'), { target: { files: [new File(['jpg'], 'clip.jpg', { type: 'image/jpeg' })] } })
    await screen.findByAltText('clip.jpg')
    expect(screen.getByText('Computer not reachable. Draft saved on this iPhone')).toBeTruthy()
    expect(sendButton().disabled).toBe(true)

    // The app is closed and opened again, still away from the computer.
    cleanup()
    const restored = await openChat()
    await linkIs({ kind: 'offline', detail: 'The computer did not answer.' })
    await waitFor(() => expect(restored.value).toBe('Make the clip 2 mm thicker'))
    expect(screen.getByAltText('clip.jpg')).toBeTruthy()
    expect(sendButton().disabled).toBe(true)
    expect(writes()).toEqual([])
  })

  it('turns Send on when the computer is back, and sends nothing until the person taps it', async () => {
    kept.set('desk-clip', { text: 'Make the clip 2 mm thicker', pictures: [{ name: 'clip.jpg', data: 'anBn' }], sent: null })
    await openChat()
    await linkIs({ kind: 'offline', detail: 'The computer did not answer.' })
    expect(sendButton().disabled).toBe(true)

    await linkIs({ kind: 'connected' })
    expect(await screen.findByText('Connected')).toBeTruthy()
    await waitFor(() => expect(sendButton().disabled).toBe(false))
    expect(writes()).toEqual([])

    fireEvent.click(sendButton())
    await waitFor(() => expect(writes()).toEqual(['PUT /chats/desk-clip/draft', 'POST /chats/desk-clip/send']))
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
  })

  it('settles a send whose answer was lost once the link is back, and starts no second job', async () => {
    await readyToSend()
    computerSide.nextSend = { commits: true, answer: lost }
    fireEvent.click(sendButton())
    await screen.findByText('Sent, not confirmed yet. The app asks the computer when it is back.')
    expect(kept.get('desk-clip')?.sent).toEqual({ rev: 41 })
    // The settle the send asked for at once found no computer, so it waits for the link.
    await waitFor(() => expect(settles()).toBe(1))
    await quietSpell()
    expect(settles()).toBe(1)
    await linkIs({ kind: 'offline', detail: 'The link dropped.' })
    expect(sendButton().disabled).toBe(true)

    computerSide.reach = true
    await linkIs({ kind: 'connected' })
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(settles()).toBe(2)
    expect(computerSide.sent).toEqual([41])
    expect(messageBox().value).toBe('')
  }, 10_000)

  it('settles a send the computer answered with an error, since it may have started it, and starts no second job', async () => {
    await readyToSend()
    computerSide.nextSend = { commits: true, answer: () => Response.json({ error: 'The chat could not be read after the send.' }, { status: 500 }) }
    fireEvent.click(sendButton())
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(settles()).toBe(1)
    expect(computerSide.sent).toEqual([41])
  })

  it('gives back a send the settle says the computer never took, with its words, and sends it as a new revision next time', async () => {
    await readyToSend()
    computerSide.nextSend = { commits: false, answer: () => Response.json({ error: 'The store could not be read.' }, { status: 500 }) }
    fireEvent.click(sendButton())
    expect(await screen.findByText('The store could not be read.')).toBeTruthy()
    await waitFor(() => expect(sendButton().disabled).toBe(false))
    expect(settles()).toBe(1)
    await waitFor(() => expect(kept.get('desk-clip')).toEqual({ text: 'Make the clip 2 mm thicker', pictures: [], sent: null }))
    expect(messageBox().value).toBe('Make the clip 2 mm thicker')

    fireEvent.click(sendButton())
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(computerSide.sent).toEqual([41, 42])
    expect(puts()).toHaveLength(2)
  })

  it.each([
    [409, 'The draft changed before it went out. Send it again.'],
    [422, 'GPT 6.1 Sol, the lead model, was retired. Choose GPT 6.3 Sol or another lead model.'],
    [423, 'The agent is still working on the last message.'],
  ])('keeps the draft and the words of a %i refusal, settles nothing, and sends the draft as a new revision next time', async (status, words) => {
    await readyToSend()
    computerSide.nextSend = { commits: false, answer: () => Response.json({ error: words }, { status }) }
    fireEvent.click(sendButton())
    expect(await screen.findByText(words)).toBeTruthy()
    await waitFor(() => expect(kept.get('desk-clip')).toEqual({ text: 'Make the clip 2 mm thicker', pictures: [], sent: null }))
    expect(computerSide.requests.filter((r) => r.includes('/settle'))).toEqual([])

    fireEvent.click(sendButton())
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(computerSide.sent).toEqual([41, 42])
  })

  it('keeps a send unconfirmed when its settle fails, and settles again only when the link comes back or the person checks again', async () => {
    await readyToSend()
    computerSide.nextSend = { commits: true, answer: () => new Response('Upstream failed', { status: 500 }) }
    computerSide.settleAnswer = () => Response.json({ error: 'The store is busy.' }, { status: 503 })
    fireEvent.click(sendButton())
    expect(await screen.findByText('The store is busy.')).toBeTruthy()
    await quietSpell()
    expect(settles()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(settles()).toBe(2))
    expect(kept.get('desk-clip')?.sent).toEqual({ rev: 41 })

    computerSide.settleAnswer = null
    await linkIs({ kind: 'offline', detail: 'The link dropped.' })
    await linkIs({ kind: 'connected' })
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(settles()).toBe(3)
    expect(computerSide.sent).toEqual([41])
  }, 10_000)

  it('settles again on the new link when a settle under way fails after the link came back', async () => {
    await readyToSend()
    computerSide.nextSend = { commits: true, answer: () => new Response('Upstream failed', { status: 500 }) }
    // The first settle fails, as one sent on a link that dropped does. The next gets the computer's answer.
    computerSide.settleAnswer = () => {
      computerSide.settleAnswer = null
      return Response.json({ error: 'The link dropped mid-check.' }, { status: 503 })
    }
    const release = hold('POST /chats/desk-clip/sends/41/settle')
    fireEvent.click(sendButton())
    await waitFor(() => expect(settles()).toBe(1))
    await linkIs({ kind: 'offline', detail: 'The link dropped.' })
    await linkIs({ kind: 'connected' })
    release()

    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(settles()).toBe(2)
    expect(computerSide.sent).toEqual([41])
  })

  it.each([['{}', {}], ['null', null], ['another chat', { project: { id: 'desk-drawer' } }]])('settles a send the computer answered with %s', async (_, body) => {
    await readyToSend()
    computerSide.nextSend = { commits: true, answer: () => Response.json(body) }
    fireEvent.click(sendButton())
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(settles()).toBe(1)
  })

  it('settles a send whose answer it cannot read', async () => {
    await readyToSend()
    computerSide.nextSend = { commits: true, answer: () => new Response('<html>Sign in</html>', { status: 200 }) }
    fireEvent.click(sendButton())
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(settles()).toBe(1)
    expect(computerSide.sent).toEqual([41])
  })

  it('never takes a settle it cannot read as accepted', async () => {
    await readyToSend()
    computerSide.nextSend = { commits: false, answer: lost }
    computerSide.settleAnswer = () => Response.json({ accepted: 'yes' })
    fireEvent.click(sendButton())
    await screen.findByText('Sent, not confirmed yet. The app asks the computer when it is back.')
    await linkIs({ kind: 'offline', detail: 'The link dropped.' })
    computerSide.reach = true
    await linkIs({ kind: 'connected' })
    await waitFor(() => expect(settles()).toBe(2))
    expect(await screen.findByText(/cannot read/)).toBeTruthy()
    expect(kept.get('desk-clip')).toEqual({ text: 'Make the clip 2 mm thicker', pictures: [], sent: { rev: 41 } })
    expect(messageBox().value).toBe('Make the clip 2 mm thicker')
  })

  it('writes the latest words to this device before the computer gets them', async () => {
    await readyToSend()
    const release = hold('PUT /chats/desk-clip/draft')
    fireEvent.change(messageBox(), { target: { value: 'Make the clip 3 mm thicker' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(kept.get('desk-clip')?.text).toBe('Make the clip 3 mm thicker'))
    expect(computerSide.sent).toEqual([])
    release()
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
  })

  it('keeps one send for a chat opened again while it goes out', async () => {
    await readyToSend()
    const release = hold('PUT /chats/desk-clip/draft')
    fireEvent.click(sendButton())
    await screen.findByText('Sending')
    backToChats()
    await reopen()
    expect(screen.getByText('Sending')).toBeTruthy()
    expect(sendButton().disabled).toBe(true)
    release()
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
    expect(writes()).toEqual(['PUT /chats/desk-clip/draft', 'POST /chats/desk-clip/send'])
    expect(messageBox().value).toBe('')
  })

  it('keeps a half-typed message after the person leaves the chat and opens it again, and locks it while a send goes out', async () => {
    const message = await openChat()
    await linkIs({ kind: 'connected' })
    fireEvent.change(message, { target: { value: 'Make the clip' } })
    backToChats()
    expect((await reopen()).value).toBe('Make the clip')
    expect(kept.get('desk-clip')?.text).toBe('Make the clip')

    // Only a draft takes edits, so nothing typed during a send can be lost under it.
    const release = hold('PUT /chats/desk-clip/draft')
    fireEvent.click(sendButton())
    await screen.findByText('Sending')
    expect(messageBox().disabled).toBe(true)
    release()
    await waitFor(() => expect(messageBox().disabled).toBe(false))
    await waitFor(() => expect(kept.has('desk-clip')).toBe(false))
  })

  it('shows a draft this device could not read, never writes over it, and reads it again on Try again', async () => {
    kept.set('desk-clip', { text: 'Make the clip 2 mm thicker', pictures: [], sent: null })
    device.loadFails = 'The saved draft is damaged. expected value at line 1 column 1'
    await openChat().catch(() => null)
    expect(await screen.findByText(/The saved draft is damaged/)).toBeTruthy()
    expect(screen.queryByLabelText('Message')).toBeNull()
    backToChats()
    fireEvent.click(await screen.findByText('Desk cable clip'))
    expect(await screen.findByText(/The saved draft is damaged/)).toBeTruthy()
    expect(invoke.mock.calls.filter(([command]) => command === 'draft_save')).toEqual([])

    device.loadFails = null
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(messageBox().value).toBe('Make the clip 2 mm thicker'))
  })

  it('forgets the computer while a send goes out, and keeps no draft from it', async () => {
    await readyToSend()
    const release = hold('PUT /chats/desk-clip/draft')
    fireEvent.click(sendButton())
    await screen.findByText('Sending')
    backToChats()
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }))
    await screen.findByText('Pair with your computer')
    release()
    await waitFor(() => expect(computerSide.requests).toContain('PUT /chats/desk-clip/draft'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(kept.has('desk-clip')).toBe(false)
    expect(computerSide.sent).toEqual([])
  })

  it('keeps no chat list that a read finishing after Forget would save', async () => {
    answerWithDrafts({ paired_computer: computer })
    const release = hold('GET /chats')
    render(<MobileApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }))
    await screen.findByText('Pair with your computer')
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(localStorage.getItem('m3d.chats')).toBeNull()
  })

  it('says the draft is saved on this device only once a write of the current words landed', async () => {
    computerSide.reach = false
    const message = await openChat()
    await linkIs({ kind: 'offline', detail: 'The computer did not answer.' })
    fireEvent.change(message, { target: { value: 'Make the clip 2 mm thicker' } })
    // The text save waits 400 ms after the last key.
    expect(screen.getByText('Computer not reachable')).toBeTruthy()
    expect(await screen.findByText('Computer not reachable. Draft saved on this iPhone')).toBeTruthy()

    device.saveFails = 'This device could not keep the draft. No space left on device'
    fireEvent.change(message, { target: { value: 'Make the clip 3 mm thicker' } })
    expect(screen.getByText('Computer not reachable')).toBeTruthy()
    expect(await screen.findByText(/No space left on device/)).toBeTruthy()
    expect(screen.getByText('Computer not reachable')).toBeTruthy()
  })

  it('forgets the computer while a send waits on this device’s write, and sends nothing after it', async () => {
    await readyToSend()
    const release = holdSave()
    fireEvent.click(sendButton())
    await screen.findByText('Sending')
    backToChats()
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }))
    release()
    await screen.findByText('Pair with your computer')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(writes()).toEqual([])
    expect(kept.has('desk-clip')).toBe(false)
  })

  it('opens no chat and writes no draft for it while Forget waits on a write', async () => {
    computerSide.list = [...computerSide.list, { id: 'desk-drawer', title: 'Desk drawer' }]
    const message = await openChat()
    await linkIs({ kind: 'connected' })
    fireEvent.change(message, { target: { value: 'Make the clip' } })
    const release = holdSave()
    backToChats()
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }))
    fireEvent.click(screen.getByText('Desk drawer'))
    expect(screen.queryByLabelText('Message')).toBeNull()
    release()
    await screen.findByText('Pair with your computer')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const drawer = invoke.mock.calls.filter(([command, args]) => command.startsWith('draft_') && args.project === 'desk-drawer')
    expect(drawer).toEqual([])
    expect(kept.size).toBe(0)
  })

  it('stays paired with working chats and its draft when Forget fails', async () => {
    const message = await openChat()
    fireEvent.change(message, { target: { value: 'Make the clip' } })
    backToChats()
    device.forgetFails = 'The Keychain refused the pairing. User interaction is not allowed.'
    fireEvent.click(await screen.findByRole('button', { name: 'Forget' }))

    expect(await screen.findByText(/The Keychain refused the pairing/)).toBeTruthy()
    expect((await reopen()).value).toBe('Make the clip')
  })

  it('shows a turn that ends after the chat was read, from the event stream alone, with Send still on', async () => {
    const asked = { id: 1, kind: 'user', text: 'Draw it' }
    computerSide.chat = { ...view, entries: [asked], running: true, seq: 4 }
    const message = await openChat()
    await linkIs({ kind: 'connected' })
    expect(await screen.findByText('Draw it')).toBeTruthy()
    const reads = computerSide.requests.filter((r) => r === 'GET /chats/desk-clip').length
    fireEvent.change(message, { target: { value: 'Now make it blue' } })

    const answer = { id: 2, kind: 'assistant', text: 'Here is the page.', calls: [], model: { provider: 'faux', modelId: 'faux-a' } }
    await linkIs({ kind: 'event', event: { type: 'chat', ...view, entries: [answer], running: false, seq: 6 } })
    expect(await screen.findByText('Here is the page.')).toBeTruthy()
    expect(computerSide.requests.filter((r) => r === 'GET /chats/desk-clip')).toHaveLength(reads)
    await waitFor(() => expect(sendButton().disabled).toBe(false))
  })
})
