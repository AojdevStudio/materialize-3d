import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Markdown from './Markdown'

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

afterEach(cleanup)

const show = (text: string) => render(<Markdown text={text} onError={() => {}} />).container

describe('Markdown', () => {
  it('renders headings', () => {
    show('# Your cube grid is ready\n\n## Print settings')
    expect(screen.getByRole('heading', { level: 1, name: 'Your cube grid is ready' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: 'Print settings' })).toBeTruthy()
  })

  it('renders lists', () => {
    show('- Watertight, one body\n- Fits the plate\n\n1. Print\n2. Assemble')
    const [bullets, steps] = screen.getAllByRole('list')
    expect(bullets.tagName).toBe('UL')
    expect(steps.tagName).toBe('OL')
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Watertight, one body', 'Fits the plate', 'Print', 'Assemble'])
  })

  it('renders tables', () => {
    show('| Setting | Value |\n| --- | --- |\n| Filament | PLA |\n| Layer height | 0.2 mm |')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Setting', 'Value'])
    expect(screen.getAllByRole('cell').map((td) => td.textContent)).toEqual(['Filament', 'PLA', 'Layer height', '0.2 mm'])
  })

  it('renders inline code and code blocks', () => {
    const page = show('Edit `SIZE` in cube_grid.py:\n\n```python\nSIZE = 20\nFILLET = 1\n```')
    const [inline, block] = page.querySelectorAll('code')
    expect(inline.textContent).toBe('SIZE')
    expect(inline.closest('pre')).toBeNull()
    expect(block.closest('pre')).toBeTruthy()
    expect(block.textContent).toBe('SIZE = 20\nFILLET = 1\n')
  })

  it('keeps a single newline as a line break, as the agent typed it', () => {
    const page = show('Size: 20 mm\nFillet: 1 mm')
    expect(page.querySelectorAll('p')).toHaveLength(1)
    expect(page.querySelector('p')?.innerHTML).toBe('Size: 20 mm<br>\nFillet: 1 mm')
  })

  it('shows raw HTML in a reply as its text, never as HTML', () => {
    const page = show('<img src="x" onerror="alert(1)">\n\nHello <b>there</b> <script>alert(2)</script>')
    expect(page.querySelector('img, b, script')).toBeNull()
    expect(page.textContent).toContain('<img src="x" onerror="alert(1)">')
    expect(page.textContent).toContain('<b>there</b>')
  })

  it('opens a web link in the browser, and shows any other link as its text', () => {
    const page = show('See [the guide](https://example.com/guide) and [the file](guide.html).')
    const link = screen.getByRole('link', { name: 'the guide' })
    fireEvent.click(link)
    expect(openUrl).toHaveBeenCalledWith('https://example.com/guide')
    expect(page.querySelectorAll('a')).toHaveLength(1)
    expect(page.textContent).toBe('See the guide and the file.')
  })
})
