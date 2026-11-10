// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

type Listener = (event: { payload: unknown }) => void
const { listeners } = vi.hoisted(() => ({ listeners: [] as Listener[] }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (_: string, listener: Listener) => {
    listeners.push(listener)
    return Promise.resolve(() => {})
  },
  emit: () => Promise.resolve(),
}))

import PopOut, { popOutFile } from './PopOut'
import { useTheme } from './theme'

afterEach(() => {
  cleanup()
  listeners.length = 0
  useTheme.setState({ theme: 'light' })
})

const project = '2026-11-06-dock'
const listing = (forProject: string, modifiedMs: number) =>
  act(() => listeners.forEach((listener) => listener({ payload: { project: forProject, files: [{ rel: 'guide.html', size: 10, modifiedMs }] } })))
const src = () => screen.getByTestId('html-preview').getAttribute('src')

describe('PopOut', () => {
  it('shows the file its address names, and only the main window has none', () => {
    expect(popOutFile('')).toBeNull()
    render(<PopOut {...popOutFile(`?project=${project}&rel=guide.html&v=5`)!} />)
    expect(src()).toBe(`m3dfile://${project}/guide.html?v=5`)
  })

  it('reloads its file when the main window lists a newer version of it', async () => {
    render(<PopOut project={project} rel="guide.html" version={5} />)
    await listing('2026-11-06-other', 9)
    expect(src()).toContain('?v=5')
    await listing(project, 9)
    expect(src()).toContain('?v=9')
  })

  it('follows a theme chosen in the main window', () => {
    render(<PopOut project={project} rel="guide.html" version={5} />)
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'materialize-3d.theme', newValue: 'dark' })))
    expect(useTheme.getState().theme).toBe('dark')
  })
})
