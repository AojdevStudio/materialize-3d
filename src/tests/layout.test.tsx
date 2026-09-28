import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import AppLayout from '../components/AppLayout'
import { NAV_ITEMS, getContextTitle } from '../components/Sidebar'
import { MAIN_TABS, getDefaultTabForView } from '../components/MainPanel'

describe('wireframe layout shell', () => {
  it('defines the sidebar destinations', () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Library',
      'MakerWorld',
      'Design',
      'Signs',
      'Print Monitor',
      'Print Queue',
      'History',
    ])
  })

  it('maps active navigation to the correct context title', () => {
    expect(getContextTitle('library')).toBe('Library')
    expect(getContextTitle('browser')).toBe('MakerWorld')
    expect(getContextTitle('monitor')).toBe('Print Monitor')
  })

  it('defines the primary workspace tabs and default mapping', () => {
    expect(MAIN_TABS.map((tab) => tab.label)).toEqual([
      'Model Library',
      '3D Preview',
      'Signs',
      'MakerWorld',
      'OpenSCAD',
      'Print Monitor',
      'Print History',
    ])
    expect(getDefaultTabForView('library')).toBe('library')
    expect(getDefaultTabForView('browser')).toBe('browser')
    expect(getDefaultTabForView('history')).toBe('history')
    expect(getDefaultTabForView('signs')).toBe('signs')
    expect(getDefaultTabForView('queue')).toBe('preview')
  })

  it('renders the core shell landmarks and placeholders', () => {
    const markup = renderToStaticMarkup(<AppLayout />)

    expect(markup).toContain('Materialize')
    expect(markup).toContain('No Printer')
    expect(markup).toContain('AI Assistant')
    expect(markup).toContain('v0.1.0')
  })
})
