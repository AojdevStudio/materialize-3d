// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const { invoke, qrText, scanner } = vi.hoisted(() => ({
  invoke: vi.fn(),
  qrText: { value: null as string | Error | null },
  scanner: { checkPermissions: vi.fn(), requestPermissions: vi.fn(), scan: vi.fn(), cancel: vi.fn() },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
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

const computer = { name: 'Studio Mac', origin: 'https://studio.tail1234.ts.net:47380/' }
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

afterEach(() => {
  computerAnswers(chats)
  Object.values(scanner).forEach((mock) => mock.mockReset())
  cleanup()
  invoke.mockReset()
  qrText.value = null
})

const choosePicture = () =>
  fireEvent.change(screen.getByLabelText('Choose a picture of the code'), { target: { files: [new File(['png'], 'code.png', { type: 'image/png' })] } })

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
    answer({ paired_computer: computer })
    computerAnswers(chats, {
      '/api/v1/chats/desk-clip': () => Response.json(deskClip),
      '/api/v1/chats/desk-clip/files': () => new Response('A folder could not be read.', { status: 500 }),
    })
    render(<MobileApp />)
    fireEvent.click(await screen.findByRole('button', { name: 'Desk cable clip' }))

    expect(await screen.findByText('Make a clip that holds a cable on the edge of my desk.')).toBeTruthy()
    expect(await screen.findByText('The model files did not load. A folder could not be read.')).toBeTruthy()
  })

  it('never fetches a model the list says is too large, and opens the newest one that fits', async () => {
    answer({ paired_computer: computer })
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
    fireEvent.click(await screen.findByRole('button', { name: 'Desk cable clip' }))

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
})
