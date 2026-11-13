// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn((_command: string, _args: { project: string; rel: string }) => Promise.resolve()) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
// jsdom draws no WebGL, so the model view names the file it was given.
vi.mock('./ModelView', () => ({ default: ({ url }: { url: string }) => <div data-testid="model-view">{url}</div> }))

import type { PanelView, ProjectFile } from './api'
import RightPanel from './RightPanel'
import { useTheme } from './theme'

afterEach(() => {
  cleanup()
  invokeMock.mockClear()
  useTheme.setState({ theme: 'light' })
})

const file = (rel: string, modifiedMs: number): ProjectFile => ({ rel, size: 10, modifiedMs })

/** A dock mount project: two guides, two drawings, a preview model, and print files, some of them the person's own. */
const project = [
  file('guide.html', 1),
  file('guide-adapter.html', 4),
  file('build/guide.template.html', 9),
  file('refs/guide.html', 8),
  file('drawing.html', 5),
  file('drawing-old.html', 2),
  file('parts.stl', 3),
  file('print/revB.3mf', 6),
  file('print/revC-adapter.3mf', 7),
  file('refs/theirs.3mf', 10),
]

const show = (files: ProjectFile[], view: PanelView, selected: string | null = null) =>
  render(<RightPanel project="2026-11-06-dock" files={files} view={view} selected={selected} onView={() => {}} onOpen={() => {}} onError={() => {}} />)

const commands = () => invokeMock.mock.calls.map(([command, args]) => [command, args.rel])

describe('RightPanel', () => {
  it('shows the newest guide and drawing at the top of the folder, and a mesh before a print file as the model', () => {
    show(project, 'guide')
    expect(screen.getByTestId('html-preview').getAttribute('src')).toContain('/guide-adapter.html?')
    cleanup()
    show(project, 'drawing')
    expect(screen.getByTestId('html-preview').getAttribute('src')).toContain('/drawing.html?')
    cleanup()
    show(project, 'model')
    expect(screen.getByTestId('model-view').textContent).toContain('/parts.stl?')
    cleanup()
    show(project.filter((f) => f.rel !== 'parts.stl'), 'model')
    expect(screen.getByTestId('model-view').textContent).toContain('/print/revC-adapter.3mf?')
  })

  it('shows the guide the person opened in place of the newest', () => {
    show(project, 'guide', 'guide.html')
    expect(screen.getByTestId('html-preview').getAttribute('src')).toContain('/guide.html?')
  })

  it('turns off the tab of a view with nothing to show', () => {
    show([file('parts.stl', 1)], 'model')
    expect(screen.getByTestId('guide-tab').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('drawing-tab').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('model-tab').hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('files-tab').hasAttribute('disabled')).toBe(false)
  })

  it('counts the print files outside refs/ and opens the newest, or another from the menu', () => {
    show(project, 'guide')
    const bar = within(screen.getByTestId('print-files'))
    expect(bar.getByText('2 print files ready')).toBeTruthy()
    fireEvent.click(bar.getByText('Open in Bambu Studio'))
    fireEvent.click(bar.getByText('Show in folder'))
    fireEvent.click(bar.getByTestId('print-pick'))
    const menu = within(bar.getByRole('menu'))
    expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['revC-adapter.3mf', 'revB.3mf'])
    fireEvent.click(menu.getByText('revB.3mf'))
    expect(bar.queryByRole('menu')).toBeNull()
    expect(commands()).toEqual([
      ['studio_open_in_bambu', 'print/revC-adapter.3mf'],
      ['studio_reveal', 'print/revC-adapter.3mf'],
      ['studio_open_in_bambu', 'print/revB.3mf'],
    ])
  })

  it('shows how many files the project holds on the Files tab', () => {
    show(project, 'guide')
    expect(screen.getByTestId('files-tab').textContent).toBe('Files 10')
    cleanup()
    show([], 'files')
    expect(screen.getByTestId('files-tab').textContent).toBe('Files')
  })

  it('reads one print file as its name, time, and grams, and several as the printer, filament, and layer height they share', () => {
    const p2s = { printer: 'P2S', filaments: ['PETG Basic'], layerHeightMm: 0.2 }
    const sliced = (rel: string, modifiedMs: number, print: ProjectFile['print']): ProjectFile => ({ ...file(rel, modifiedMs), print })
    const details = () => screen.queryByTestId('print-details')?.textContent

    show([sliced('print/cube.3mf', 1, { ...p2s, printSeconds: 4320, filamentGrams: 38.2 })], 'model')
    expect(details()).toBe('cube.3mf · 1 h 12 min · 38 g PETG Basic')
    cleanup()
    show([sliced('print/revB.3mf', 1, p2s), sliced('print/revC.3mf', 2, { ...p2s, filaments: ['PLA Basic'] })], 'model')
    expect(details()).toBe('P2S · 0.20 mm')
    cleanup()
    show([sliced('print/cube.3mf', 1, { filaments: [] })], 'model')
    expect(details()).toBe('cube.3mf')
    cleanup()
    show([sliced('print/plate.3mf', 1, { filaments: [], printSeconds: 0 })], 'model')
    expect(details()).toBe('plate.3mf')
  })

  it('shortens only a long file name, so the time and grams stay in view, and shows the whole line on hover', () => {
    const long = 'print/a-very-long-bracket-name-that-fills-the-bar.3mf'
    show([{ ...file(long, 1), print: { filaments: ['PETG Basic'], printSeconds: 4320, filamentGrams: 38.2 } }], 'model')
    const details = screen.getByTestId('print-details')
    expect(details.getAttribute('title')).toBe(details.textContent)
    // jsdom draws no layout, so the check is that the time and grams sit outside the part that shortens.
    expect(details.querySelector('.print-lead')?.textContent).toBe('a-very-long-bracket-name-that-fills-the-bar.3mf')
    expect(details.querySelector('.print-rest')?.textContent).toBe(' · 1 h 12 min · 38 g PETG Basic')
  })

  it('shows one print file without a menu, and no bar without print files', () => {
    show([file('print/part.3mf', 1)], 'model')
    expect(screen.getByText('1 print file ready')).toBeTruthy()
    expect(screen.queryByTestId('print-pick')).toBeNull()
    cleanup()
    show([file('guide.html', 1)], 'guide')
    expect(screen.queryByTestId('print-files')).toBeNull()
  })

  it('pops out what the view shows, and offers no pop out for the list of files', () => {
    show(project, 'guide')
    fireEvent.click(screen.getByTestId('pop-out'))
    expect(commands()).toEqual([['studio_pop_out', 'guide-adapter.html']])
    cleanup()
    show(project, 'files')
    expect(screen.queryByTestId('pop-out')).toBeNull()
  })

  it('opens a page in the app theme and tells it each toggle, without reloading it', () => {
    act(() => useTheme.setState({ theme: 'dark' }))
    show(project, 'guide')
    const frame = screen.getByTestId('html-preview') as HTMLIFrameElement
    const opened = frame.getAttribute('src')
    expect(opened).toMatch(/\/guide-adapter\.html\?v=4&theme=dark$/)
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    act(() => useTheme.getState().toggle())
    expect(post).toHaveBeenCalledWith({ type: 'm3d:theme', theme: 'light' }, '*')
    expect(screen.getByTestId('html-preview')).toBe(frame)
    expect(frame.getAttribute('src')).toBe(opened)
  })
})
