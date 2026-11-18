// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type Attachment, Composer, type PastedPicture } from './Composer'

const dialog = vi.hoisted(() => ({ pickFile: vi.fn<() => Promise<string | null>>() }))
vi.mock('../lib/fileDialog', () => dialog)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type Shown = { text?: string; attachments?: Attachment[]; busy?: boolean; running?: boolean; locked?: string; stop?: boolean }

function show({ text = 'A cable clip', attachments = [], busy = false, running = false, locked, stop = true }: Shown = {}) {
  const calls = { onSend: vi.fn(), onStop: vi.fn(), onError: vi.fn(), onPaste: vi.fn<(pictures: PastedPicture[]) => void>() }
  render(
    <Composer
      text={text}
      onText={() => {}}
      attachments={attachments}
      onAttach={() => {}}
      onPaste={calls.onPaste}
      onRemove={() => {}}
      onSend={calls.onSend}
      onError={calls.onError}
      onStop={stop ? calls.onStop : undefined}
      busy={busy}
      running={running}
      place="chat"
      locked={locked}
      picker={null}
    />,
  )
  return calls
}

const prompt = () => screen.getByTestId('prompt') as HTMLTextAreaElement
const send = () => screen.getByTestId('send') as HTMLButtonElement

describe('Composer', () => {
  it('sends on Enter, and not on Shift+Enter or while an input method composes', () => {
    const { onSend } = show()
    fireEvent.keyDown(prompt(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(prompt(), { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledOnce()
    fireEvent.click(send())
    expect(onSend).toHaveBeenCalledTimes(2)
  })

  it('keeps Send off with nothing to send, while busy, and while locked, and says the lock in place of the placeholder', () => {
    const empty = show({ text: '  ' })
    expect(send().disabled).toBe(true)
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(empty.onSend).not.toHaveBeenCalled()
    cleanup()

    show({ text: '', attachments: [{ name: 'photo.jpg', path: '/tmp/photo.jpg' }] })
    expect(send().disabled).toBe(false)
    cleanup()

    show({ busy: true })
    expect(send().disabled).toBe(true)
    cleanup()

    const locked = show({ locked: 'Log in to an agent to send' })
    expect(send().disabled).toBe(true)
    expect(prompt().placeholder).toBe('Log in to an agent to send')
    expect(prompt().closest('.composer')?.className).toBe('composer locked')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(locked.onSend).not.toHaveBeenCalled()
  })

  it('names a pasted image.png, or a picture with no name, after the time, and keeps any other name', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const { onPaste } = show()
    const files = [
      new File(['a'], 'image.png', { type: 'image/png' }),
      new File(['b'], 'notes.txt', { type: 'text/plain' }),
      new File(['c'], 'photo.jpg', { type: 'image/jpeg' }),
      new File(['d'], '', { type: 'image/svg+xml' }),
    ]
    const pasted = fireEvent.paste(prompt(), { clipboardData: { files } })
    expect(pasted).toBe(false)
    expect(onPaste.mock.calls[0]?.[0].map(({ name, file }) => [name, file.name])).toEqual([
      ['pasted-1700000000000-0.png', 'image.png'],
      ['photo.jpg', 'photo.jpg'],
      ['pasted-1700000000000-2.svg+xml', ''],
    ])
  })

  it('leaves a paste with no picture to the text field', () => {
    const { onPaste } = show()
    const pasted = fireEvent.paste(prompt(), { clipboardData: { files: [new File(['b'], 'notes.txt', { type: 'text/plain' })] } })
    expect(pasted).toBe(true)
    expect(onPaste).not.toHaveBeenCalled()
  })

  it('shows Stop in place of Send while a turn runs, when the owner can stop it', () => {
    const { onStop, onSend } = show({ running: true })
    expect(screen.queryByTestId('send')).toBeNull()
    fireEvent.click(screen.getByTestId('stop'))
    expect(onStop).toHaveBeenCalledOnce()
    expect(onSend).not.toHaveBeenCalled()
    cleanup()

    show({ running: true, stop: false })
    expect(screen.queryByTestId('stop')).toBeNull()
    expect(send().disabled).toBe(false)
  })

  it('shows a file dialog that fails in the error bar', async () => {
    dialog.pickFile.mockRejectedValueOnce(new Error('The dialog could not open'))
    const { onError } = show()
    fireEvent.click(screen.getByTestId('attach'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Error: The dialog could not open'))
  })
})
