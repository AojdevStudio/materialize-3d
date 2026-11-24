// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const { invoke, qrText } = vi.hoisted(() => ({ invoke: vi.fn(), qrText: { value: null as string | Error | null } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-barcode-scanner', () => ({ Format: { QRCode: 'QR_CODE' }, scan: vi.fn() }))
// jsdom draws no pictures, so the picture's QR text is set by each test.
vi.mock('./qr', () => ({
  readQrPicture: async () => {
    if (qrText.value instanceof Error) throw qrText.value
    return qrText.value
  },
}))

import MobileApp from './MobileApp'

const computer = { name: 'Studio Mac', origin: 'https://studio.tail1234.ts.net:47380/' }
const link = 'https://studio.tail1234.ts.net:47380/pair?code=K7Q2'

function answer(commands: Record<string, unknown>) {
  invoke.mockImplementation(async (command: string) => commands[command])
}

const chats = () => Response.json([{ id: 'desk-clip', title: 'Desk cable clip' }])
const computerAnswers = (answer: () => Response) =>
  vi.stubGlobal('fetch', async (url: string) => (url === 'm3dremote://localhost/api/v1/chats' ? answer() : new Response('Not found', { status: 404 })))
computerAnswers(chats)

afterEach(() => {
  computerAnswers(chats)
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
})
