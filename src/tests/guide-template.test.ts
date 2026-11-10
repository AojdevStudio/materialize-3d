import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it } from 'vitest'
// The guide template the sidecar ships, read here because it lives in the sidecar.
import template from '../../sidecar/src/templates/guide.html?raw'

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
    expect(open('?v=1&theme=dark').theme()).toBe('dark')
    expect(open('?v=1&theme=light').theme()).toBe('light')
    expect(open('?v=1').theme()).toBe('light')
  })

  it('flips when the app posts a new theme', () => {
    const page = open('?theme=light')
    page.post({ type: 'm3d:theme', theme: 'dark' })
    expect(page.theme()).toBe('dark')
    page.post({ type: 'm3d:theme', theme: 'light' })
    expect(page.theme()).toBe('light')
  })

  it('ignores a message of any other shape, or from anyone but the app', () => {
    const page = open('?theme=light')
    for (const data of ['dark', null, { theme: 'dark' }, { type: 'theme', theme: 'dark' }, { type: 'm3d:theme', theme: 'blue' }]) page.post(data)
    page.post({ type: 'm3d:theme', theme: 'dark' }, null)
    expect(page.theme()).toBe('light')
  })
})
