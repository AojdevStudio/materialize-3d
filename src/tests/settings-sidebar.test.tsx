import { readFileSync } from 'node:fs'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: () => new Promise(() => {}) }))

import Settings, { type Section } from '../studio/Settings'

function Open({ from }: { from: Section }) {
  const [section, setSection] = useState<Section>(from)
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

// Each getComputedStyle call in jsdom copies the element's whole style, so each element gets one call.
const looks = (element: Element, props: (keyof CSSStyleDeclaration)[]) => {
  const style = getComputedStyle(element)
  return props.map((prop) => style[prop])
}
const panel: (keyof CSSStyleDeclaration)[] = ['width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'background']
const row: (keyof CSSStyleDeclaration)[] = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontSize', 'fontWeight', 'background']

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = readFileSync(`${import.meta.dirname}/../studio/studio.css`, 'utf8')
  document.head.append(style)
  // The first style read with studio.css builds jsdom's selector cache. Pay it here, outside any test's timeout.
  getComputedStyle(document.body)
})

afterEach(cleanup)

/** The main sidebar with an open and a closed project, beside Settings. */
function sidebars(from: Section) {
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
      <Open from={from} />
    </>,
  )
  return { main: screen.getByRole('navigation', { name: 'Projects' }), nav: screen.getByRole('navigation', { name: 'Settings' }) }
}

describe('Settings sidebar', () => {
  it('looks like the main sidebar', () => {
    const { main, nav } = sidebars('agents')
    expect(looks(nav, panel)).toEqual(looks(main, panel))
  })

  // Each item opens from the section the one before it left open, so a click always changes the section.
  it.each([
    { from: 'agents', name: 'Slicer and printer' },
    { from: 'slicer', name: 'Build tools' },
    { from: 'tools', name: 'Projects folder' },
    { from: 'folder', name: 'Agents and models' },
  ] as const)('$name opens its section, and only it has the selected fill', ({ from, name }) => {
    const { main, nav } = sidebars(from)
    // A role query reads a fresh style for each button it checks, and a click throws those away. So the reference rows,
    // which this test draws itself, skip the check that they show. The Settings items get it once, after the click.
    const [open, closed] = within(main).getAllByRole('button', { hidden: true }).map((each) => looks(each, row))
    const item = within(nav).getByText(name)
    fireEvent.click(item)
    // jsdom counts the last clicked element as hovered, so the pointer leaves before the selected fill is read.
    fireEvent.mouseOut(item)
    expect(screen.getByRole('region', { name })).toBeTruthy()
    const items = within(nav).getAllByRole('button')
    // The role query leaves out hidden buttons, so all four items, the clicked one among them, must still be listed.
    expect(items).toHaveLength(4)
    expect(items).toContain(item)
    expect(items.map((each) => looks(each, row))).toEqual(items.map((each) => (each === item ? open : closed)))
  })
})
