// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'

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

/** The start screen over these projects, each with its status as the sidebar keeps it and the files in its folder. */
function start(projects: Record<string, { status: ProjectStatus; files: ProjectFile[] }>) {
  invokeMock.mockImplementation((command: string, args: { project: string }) =>
    Promise.resolve(command === 'studio_files' ? projects[args.project].files : undefined),
  )
  const status = Object.fromEntries(Object.entries(projects).map(([id, p]) => [id, p.status]))
  render(<Start projects={Object.keys(projects).map(project)} status={status} composer={null} onSuggest={ignore} onOpen={ignore} onError={ignore} />)
  return within(screen.getByTestId('recent'))
}

describe('Start', () => {
  it.each([
    ['working', status(1, { running: true, printed: true, printFiles: 1 }), [file('guide.html')]],
    ['printed', status(1, { printed: true, printFiles: 1 }), [file('guide.html')]],
    ['3MF ready', status(1, { printFiles: 1 }), [file('guide.html')]],
    ['guide ready', status(1), [file('guide-adapter.html')]],
    // A drawing is not a guide, and neither is a guide page in a subfolder or among the person's own files.
    ['draft', status(1), [file('drawing.html'), file('parts/guide.html'), file('refs/guide.html')]],
  ])('says "%s" under a recent project in that state', async (line, status, files) => {
    const recent = start({ part: { status, files } })
    await waitFor(() => expect(recent.getByTestId('recent-part').textContent).toBe(`part${line}`))
  })

  it('offers only the two newest projects, so the chips keep to one row', async () => {
    const recent = start({
      a: { status: status(1), files: [] },
      b: { status: status(4), files: [] },
      c: { status: status(3), files: [] },
      d: { status: status(2), files: [] },
    })
    await waitFor(() => expect(recent.getAllByRole('button').map((chip) => chip.textContent)).toEqual(['bdraft', 'cdraft']))
  })
})
