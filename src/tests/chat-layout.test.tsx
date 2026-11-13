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
  <ChatView project="p" items={items} running={running} startedMs={undefined} onPreview={() => {}} onError={() => {}} />
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
    rerender(chat([ask, ask, reply]))
    expect(scroll).toHaveBeenCalledWith({ block: 'end' })
  })
})
