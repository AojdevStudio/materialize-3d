// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => {}) }))

import type { Project, ProjectStatus } from '../../sidecar/src/protocol'
import type { ProjectFile } from './api'
import Start from './Start'

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
})

const project = (id: string): Project => ({ id, conversation: 1, title: id, createdMs: 0 })
const status = (lastMs: number, more: Partial<ProjectStatus> = {}): ProjectStatus => ({ running: false, printed: false, printFiles: 0, lastMs, ...more })
const file = (rel: string): ProjectFile => ({ rel, size: 1, modifiedMs: 1 })
const ignore = () => {}

/** Each project's folder as the app lists it. A function answers a read itself, to hold or fail it. */
let folders: Record<string, ProjectFile[] | (() => Promise<ProjectFile[]>)> = {}

/** The start screen over projects with these statuses, as the sidebar keeps them. `update` gives it new ones. */
function start(statuses: Record<string, ProjectStatus>, onError: (message: string) => void = ignore) {
  invokeMock.mockImplementation((command: string, args: { project: string }) => {
    const folder = folders[args.project]
    if (command !== 'studio_files') return Promise.resolve(undefined)
    return typeof folder === 'function' ? folder() : Promise.resolve(folder)
  })
  const view = (now: Record<string, ProjectStatus>) => (
    <Start projects={Object.keys(now).map(project)} status={now} composer={null} onSuggest={ignore} onOpen={ignore} onError={onError} />
  )
  const { rerender } = render(view(statuses))
  const recent = within(screen.getByTestId('recent'))
  return { recent, chip: (id: string) => recent.getByTestId(`recent-${id}`).textContent, update: (now: Record<string, ProjectStatus>) => rerender(view(now)) }
}

describe('Start', () => {
  it.each([
    ['working', status(1, { running: true, printed: true, printFiles: 1 }), [file('guide.html')]],
    ['printed', status(1, { printed: true, printFiles: 1 }), [file('guide.html')]],
    ['3MF ready', status(1, { printFiles: 1 }), [file('guide.html')]],
    ['guide ready', status(1), [file('guide-adapter.html')]],
    ['draft', status(1), [file('drawing.html'), file('parts/guide.html'), file('refs/guide.html')]],
  ])('says "%s" under a recent project in that state', async (line, partStatus, files) => {
    folders = { part: files }
    const { chip } = start({ part: partStatus })
    await waitFor(() => expect(chip('part')).toBe(`part${line}`))
  })

  it('offers only the two newest projects, so the chips keep to one row', async () => {
    folders = { a: [], b: [], c: [], d: [] }
    const { recent } = start({ a: status(1), b: status(4), c: status(3), d: status(2) })
    await waitFor(() => expect(recent.getAllByRole('button').map((chip) => chip.textContent)).toEqual(['bdraft', 'cdraft']))
  })

  it('keeps a line until the folder is read again, so a turn that wrote a guide never reads as a draft', async () => {
    folders = { part: [] }
    const { chip, update } = start({ part: status(1, { running: true }) })
    await waitFor(() => expect(chip('part')).toBe('partworking'))
    let release = () => {}
    folders.part = () => new Promise((resolve) => (release = () => resolve([file('guide.html')])))
    update({ part: status(1) })
    await act(() => Promise.resolve())
    expect(chip('part')).toBe('partworking')
    await act(async () => release())
    await waitFor(() => expect(chip('part')).toBe('partguide ready'))
  })

  it('reads the folder again when a turn ends, though the turn wrote nothing newer', async () => {
    folders = { part: [file('guide.html')] }
    const { chip, update } = start({ part: status(1) })
    await waitFor(() => expect(chip('part')).toBe('partguide ready'))
    update({ part: status(5, { running: true }) })
    await waitFor(() => expect(chip('part')).toBe('partworking'))
    folders.part = []
    update({ part: status(5) })
    await waitFor(() => expect(chip('part')).toBe('partdraft'))
  })

  it("shows each project's state though another project's folder could not be read", async () => {
    folders = { a: [file('guide.html')], b: () => Promise.reject(new Error('gone')) }
    const onError = vi.fn()
    const { chip } = start({ a: status(2), b: status(1) }, onError)
    await waitFor(() => expect(chip('a')).toBe('aguide ready'))
    expect(onError).toHaveBeenCalledWith('Error: gone')
  })

  it('drops a working line when its turn ends, though the folder read after it fails', async () => {
    folders = { part: [] }
    const { chip, update } = start({ part: status(1, { running: true }) })
    await waitFor(() => expect(chip('part')).toBe('partworking'))
    folders = { part: () => Promise.reject(new Error('gone')) }
    update({ part: status(2, { printFiles: 1 }) })
    await waitFor(() => expect(chip('part')).toBe('part3MF ready'))
  })

  it('shows no line for a draft whose folder read fails, as only the folder tells a guide from a draft', async () => {
    folders = { part: [file('guide.html')] }
    const { chip, update } = start({ part: status(1, { printFiles: 1 }) })
    await waitFor(() => expect(chip('part')).toBe('part3MF ready'))
    folders = { part: () => Promise.reject(new Error('gone')) }
    update({ part: status(2) })
    await waitFor(() => expect(chip('part')).toBe('part'))
  })
})
