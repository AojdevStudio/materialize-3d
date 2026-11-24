// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
const neverArrives = () => new Promise(() => {})
vi.stubGlobal('fetch', neverArrives)

afterEach(() => {
  vi.stubGlobal('fetch', neverArrives)
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

  it('names itself as loading until the model is drawn, which the mobile UI test waits on', async () => {
    const triangle = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n'
    let arrive: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (arrive = resolve)))
    render(<ModelView url="m3dfile://2026-11-06-dock/parts.stl" ext="stl" />)
    expect(screen.getByTestId('model-view').getAttribute('aria-label')).toBe('Loading the 3D model')
    arrive(new Response(triangle))
    await waitFor(() => expect(screen.getByTestId('model-view').getAttribute('aria-label')).toBe('3D model parts.stl'))
  })

  it('starts on true black in dark', () => {
    useTheme.setState({ theme: 'dark' })
    render(<ModelView url="m3dfile://2026-11-06-dock/parts.stl" ext="stl" />)
    expect(background()).toBe(0x000000)
  })
})
