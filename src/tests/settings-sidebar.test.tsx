import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => new Promise(() => {}) }))

import Settings, { type Section } from '../studio/Settings'

function Open() {
  const [section, setSection] = useState<Section>('agents')
  return (
    <Settings
      section={section}
      onSection={setSection}
      models={[]}
      onSaved={() => {}}
      onFix={() => {}}
      onClose={() => {}}
      onError={() => {}}
      error={null}
      signIn={null}
      signIns={0}
    />
  )
}

const looks = (element: Element, props: (keyof CSSStyleDeclaration)[]) => props.map((prop) => getComputedStyle(element)[prop])
const panel: (keyof CSSStyleDeclaration)[] = ['width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'background']
const row: (keyof CSSStyleDeclaration)[] = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontSize', 'fontWeight', 'background']

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = readFileSync(`${import.meta.dirname}/../studio/studio.css`, 'utf8')
  document.head.append(style)
})

afterEach(cleanup)

describe('Settings sidebar', () => {
  it('looks like the main sidebar, and each item opens its section with the selected fill', () => {
    render(
      <>
        <nav className="sessions" aria-label="Projects">
          <button type="button" className="row-open" aria-current={true}>
            Open project
          </button>
          <button type="button" className="row-open" aria-current={false}>
            Other project
          </button>
        </nav>
        <Open />
      </>,
    )
    const main = screen.getByRole('navigation', { name: 'Projects' })
    const [open, closed] = within(main).getAllByRole('button')
    const nav = screen.getByRole('navigation', { name: 'Settings' })
    expect(looks(nav, panel)).toEqual(looks(main, panel))
    for (const name of ['Slicer and printer', 'Build tools', 'Projects folder', 'Agents and models']) {
      const item = within(nav).getByRole('button', { name })
      fireEvent.click(item)
      // jsdom counts the last clicked element as hovered, so the pointer leaves before the selected fill is read.
      fireEvent.mouseOut(item)
      expect(screen.getByRole('region', { name })).toBeTruthy()
      for (const each of within(nav).getAllByRole('button')) {
        expect(looks(each, row)).toEqual(looks(each.textContent === name ? open : closed, row))
      }
    }
  })
})
