// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import page from '../../index.html?raw'

// The theme is read once, when the module loads, as at the app's start. Each test loads it fresh.
const start = async () => {
  const { useTheme, useWindowTheme } = await import('./theme')
  renderHook(useWindowTheme)
  return useTheme.getState().theme
}

afterEach(() => {
  cleanup()
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

  it('takes a choice another window saved after the app loaded and before the window started', async () => {
    const { useTheme, useWindowTheme } = await import('./theme')
    window.localStorage.setItem('materialize-3d.theme', 'dark')
    renderHook(useWindowTheme)
    expect(useTheme.getState().theme).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

describe('the theme contract', () => {
  it('index.html reads the saved choice before the first paint with the key and rule theme.ts saves it by', async () => {
    const { useTheme } = await import('./theme')
    const boot = new Function(/<script>([\s\S]*?)<\/script>/.exec(page)![1])
    for (const theme of ['dark', 'light']) {
      useTheme.getState().toggle()
      delete document.documentElement.dataset.theme
      boot()
      expect(document.documentElement.dataset.theme).toBe(theme)
    }
  })
})
