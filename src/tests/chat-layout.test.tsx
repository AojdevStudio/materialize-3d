import { readFileSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../studio/Chat'
import type { ChatItem } from '../studio/transcript'

const ask: ChatItem = { kind: 'user', text: 'Make a 2x2 grid of 20 mm cubes', images: [], files: [] }
const reply: ChatItem = { kind: 'text', text: 'On it.' }
const scroll = vi.fn()
Element.prototype.scrollIntoView = scroll

const chat = (items: ChatItem[], running = false) => (
  <ChatView items={items} running={running} startedMs={undefined} onError={() => {}} />
)

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = readFileSync(`${import.meta.dirname}/../studio/studio.css`, 'utf8')
  document.head.append(style)
})

afterEach(cleanup)

describe('ChatView', () => {
  it('pushes a short chat down to the composer', () => {
    render(chat([ask, reply]))
    const first = screen.getByTestId('messages').firstElementChild as Element
    expect(getComputedStyle(first).marginTop).toBe('auto')
  })

  it('scrolls the newest message into view after a send and after a turn ends', () => {
    const { rerender } = render(chat([ask]))
    scroll.mockClear()
    rerender(chat([ask, ask], true))
    expect(scroll).toHaveBeenCalledWith({ block: 'end' })
    scroll.mockClear()
    rerender(chat([ask, ask]))
    expect(scroll).toHaveBeenCalledWith({ block: 'end' })
  })

  it('shows a message’s picture where it loads from, and by its name where none is given, as on a phone', () => {
    const photo: ChatItem = { ...ask, images: ['refs/shelf.jpg'] }
    const { rerender } = render(<ChatView pictureUrl={(rel) => `m3dfile://p/${rel}`} items={[photo]} running={false} startedMs={undefined} onError={() => {}} />)
    expect(screen.getByRole('img', { name: 'refs/shelf.jpg' }).getAttribute('src')).toBe('m3dfile://p/refs/shelf.jpg')
    rerender(chat([photo]))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('shelf.jpg')).toBeTruthy()
  })
})
