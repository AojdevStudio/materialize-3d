// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { Color, Scene } from 'three'

const { drawn } = vi.hoisted(() => ({ drawn: [] as Scene[] }))
// jsdom has no WebGL. This renderer keeps each scene it is asked to draw.
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>()
  class WebGLRenderer {
    domElement = document.createElement('canvas')
    setPixelRatio() {}
    setSize() {}
    dispose() {}
    render(scene: Scene) {
      drawn.push(scene)
    }
  }
  return { ...three, WebGLRenderer }
})

import ModelView from './ModelView'
import { useTheme } from './theme'

// The model never arrives, so only the empty scene is drawn.
vi.stubGlobal('fetch', () => new Promise(() => {}))

afterEach(() => {
  cleanup()
  drawn.length = 0
  useTheme.setState({ theme: 'light' })
})

const background = () => (drawn[drawn.length - 1].background as Color).getHex()

describe('ModelView', () => {
  it('draws its scene on the theme background, and again when the theme changes', () => {
    render(<ModelView url="m3dfile://2026-11-06-dock/parts.stl" ext="stl" />)
    expect(background()).toBe(0xf6f6f4)
    act(() => useTheme.getState().toggle())
    expect(background()).toBe(0x000000)
    act(() => useTheme.getState().toggle())
    expect(background()).toBe(0xf6f6f4)
  })

  it('starts on true black in dark', () => {
    useTheme.setState({ theme: 'dark' })
    render(<ModelView url="m3dfile://2026-11-06-dock/parts.stl" ext="stl" />)
    expect(background()).toBe(0x000000)
  })
})
