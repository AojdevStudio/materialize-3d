import { JSDOM, VirtualConsole } from 'jsdom'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// The guide template the sidecar ships, read here because it lives in the sidecar.
import template from '../../sidecar/src/templates/guide.html?raw'
import { FRAME_THEME } from '../studio/theme'

const { query, message } = FRAME_THEME

/**
 * The template as the app opens it, at `query`. The raw template has no three.js or data yet, so its scene script stops
 * at once, and the quiet console drops that error. The theme script in its head has run by then.
 */
function open(query: string) {
  const dom = new JSDOM(template, { url: `m3dfile://2026-11-09-clip/guide.html${query}`, runScripts: 'dangerously', virtualConsole: new VirtualConsole() })
  const { window } = dom
  return {
    theme: () => window.document.documentElement.dataset.theme,
    /** A message as the app posts it from the window around the frame, or from `source` when given. */
    post: (data: unknown, source: Window | null = window.parent) => window.dispatchEvent(new window.MessageEvent('message', { data, source })),
  }
}

describe('the guide template', () => {
  it('opens in the theme its address names, and light without one', () => {
    expect(open(`?v=1&${query}=dark`).theme()).toBe('dark')
    expect(open(`?v=1&${query}=light`).theme()).toBe('light')
    expect(open('?v=1').theme()).toBe('light')
  })

  it('flips when the app posts a new theme', () => {
    const page = open(`?${query}=light`)
    page.post({ type: message, theme: 'dark' })
    expect(page.theme()).toBe('dark')
    page.post({ type: message, theme: 'light' })
    expect(page.theme()).toBe('light')
  })

  it('ignores a message of any other shape, or from anyone but the app', () => {
    const page = open(`?${query}=light`)
    for (const data of ['dark', null, { theme: 'dark' }, { type: 'theme', theme: 'dark' }, { type: message, theme: 'blue' }]) page.post(data)
    page.post({ type: message, theme: 'dark' }, null)
    expect(page.theme()).toBe('light')
  })

  it('shows the window colors it shares, in both themes', () => {
    // Each guide color that stands for a window color, by the window token it stands for.
    const SHARED: Record<string, string> = {
      bg: 's-raised',
      panel: 's-raised',
      chip: 's-raised',
      fg: 's-text',
      dim: 's-muted',
      line: 's-line',
      accent: 's-accent',
      ok: 's-ready',
      btn: 's-primary',
      btnfg: 's-primary-text',
    }
    const hex = (value: string) => {
      const color = value.trim().toLowerCase()
      return color.length === 4 ? `#${[...color.slice(1)].map((c) => c + c).join('')}` : color
    }
    const tokens = (css: string, selector: string) => {
      const from = css.indexOf(selector)
      const block = css.slice(from, css.indexOf('}', from))
      return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]+)/g)].map(([, name, value]) => [name, hex(value)]))
    }
    for (const [guideSelector, studioSelector] of [
      [':root{', ':root {'],
      [':root[data-theme="dark"]{', ":root[data-theme='dark'] {"],
    ]) {
      const inGuide = tokens(template, guideSelector)
      const inStudio = tokens(readFileSync(`${import.meta.dirname}/../studio/studio.css`, 'utf8'), studioSelector)
      for (const [name, token] of Object.entries(SHARED)) {
        expect(inStudio[token]).toMatch(/^#[0-9a-f]{6}$/)
        expect([name, inGuide[name]]).toEqual([name, inStudio[token]])
      }
    }
  })
})
