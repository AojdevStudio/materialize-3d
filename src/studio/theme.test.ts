// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The theme is read once, when the module loads, as at the app's start. Each test loads it fresh.
const start = async () => (await import('./theme')).useTheme.getState().theme

afterEach(() => {
  window.localStorage.clear()
  vi.resetModules()
})

describe('theme', () => {
  it('starts light when nothing was saved', async () => {
    expect(await start()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('starts dark when the person chose dark before', async () => {
    window.localStorage.setItem('materialize-3d.theme', 'dark')
    expect(await start()).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
