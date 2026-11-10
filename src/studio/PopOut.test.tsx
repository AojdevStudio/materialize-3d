// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

const { listed } = vi.hoisted(() => ({ listed: { modifiedMs: 5 } }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string) =>
    command === 'studio_files' ? Promise.resolve([{ rel: 'guide.html', size: 10, modifiedMs: listed.modifiedMs }]) : Promise.reject(command),
}))

import PopOut, { popOutFile } from './PopOut'
import { useTheme } from './theme'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  listed.modifiedMs = 5
  useTheme.setState({ theme: 'light' })
})

const project = '2026-11-06-dock'
const src = () => screen.getByTestId('html-preview').getAttribute('src')

describe('PopOut', () => {
  it('shows the file its address names, and only the main window has none', () => {
    expect(popOutFile('')).toBeNull()
    render(<PopOut {...popOutFile(`?project=${project}&rel=guide.html&v=5`)!} />)
    expect(src()).toBe(`m3dfile://${project}/guide.html?v=5`)
  })

  it('reloads its file when the file changes on disk', async () => {
    render(<PopOut project={project} rel="guide.html" version={5} />)
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(src()).toContain('?v=5')
    listed.modifiedMs = 9
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(src()).toContain('?v=9')
  })

  it('follows a theme chosen in the main window', () => {
    render(<PopOut project={project} rel="guide.html" version={5} />)
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'materialize-3d.theme', newValue: 'dark' })))
    expect(useTheme.getState().theme).toBe('dark')
  })
})
