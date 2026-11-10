// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

/** The file on disk as `studio_file_version` reads it: its version, or gone. */
const { disk, project } = vi.hoisted(() => ({ disk: { version: 5 as number | 'gone' }, project: '2026-11-06-dock' }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: { project: string; rel: string }) =>
    command !== 'studio_file_version' ? Promise.reject(command)
    : args.project !== project || args.rel !== 'guide.html' ? Promise.reject(`asked about ${JSON.stringify(args)}`)
    : disk.version === 'gone' ? Promise.reject('guide.html: No such file or directory')
    : Promise.resolve(disk.version),
}))

import PopOut, { popOutFile } from './PopOut'
import { useTheme } from './theme'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  disk.version = 5
  useTheme.setState({ theme: 'light' })
})

const src = () => screen.getByTestId('html-preview').getAttribute('src')
const later = () => act(() => vi.advanceTimersByTimeAsync(2000))

describe('PopOut', () => {
  it('shows the file its address names, and only the main window has none', () => {
    expect(popOutFile('')).toBeNull()
    render(<PopOut {...popOutFile(`?project=${project}&rel=guide.html&v=5`)!} />)
    expect(src()).toBe(`m3dfile://${project}/guide.html?v=5`)
  })

  it('reloads its file when it changes, says when it is gone, and goes on when it comes back', async () => {
    disk.version = 9
    render(<PopOut project={project} rel="guide.html" version={5} />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(src()).toContain('?v=9')

    disk.version = 'gone'
    await later()
    expect(screen.getByText(/This window cannot read its file\. guide\.html: No such file/)).toBeTruthy()

    disk.version = 12
    await later()
    expect(screen.queryByText(/This window cannot read/)).toBeNull()
    expect(src()).toContain('?v=12')
  })

  it('follows a theme chosen in the main window', () => {
    render(<PopOut project={project} rel="guide.html" version={5} />)
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'materialize-3d.theme', newValue: 'dark' })))
    expect(useTheme.getState().theme).toBe('dark')
  })
})
