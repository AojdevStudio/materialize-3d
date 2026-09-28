import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

// Mock @tauri-apps/api/core to prevent actual IPC calls
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}))

// Mock @react-three/fiber Canvas — WebGL not available in jsdom
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'r3f-canvas' }, children),
  useThree: () => ({
    camera: { position: { copy: vi.fn() } },
    gl: {},
    scene: {},
  }),
}))

// Mock @react-three/drei components — depend on R3F context
vi.mock('@react-three/drei', () => ({
  OrbitControls: React.forwardRef((_props: any, _ref: any) =>
    React.createElement('div', { 'data-testid': 'orbit-controls' }),
  ),
  Grid: () => React.createElement('div', { 'data-testid': 'grid' }),
  Center: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  Bounds: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  useBounds: () => ({
    refresh: () => ({ clip: () => ({ fit: vi.fn() }) }),
  }),
}))

// Mock three.js loaders
vi.mock('three/examples/jsm/loaders/STLLoader.js', () => ({
  STLLoader: vi.fn(),
}))
vi.mock('three/examples/jsm/loaders/3MFLoader.js', () => ({
  ThreeMFLoader: vi.fn(),
}))

// Import after mocks
const { ModelViewer, useModelLoader } = await import('../components/ModelViewer')

// Access workspace store for state manipulation
const { useWorkspaceStore } = await import('../stores/workspace')

describe('ModelViewer', () => {
  beforeEach(() => {
    // Reset workspace store to default
    useWorkspaceStore.setState({
      activeModel: null,
      activeView: 'preview',
    })
  })

  it('renders without crashing in empty state (no activeModel)', () => {
    const { container } = render(<ModelViewer />)
    // Verify viewer container renders
    expect(container.querySelector('[data-testid="model-viewer-container"]')).toBeTruthy()
    // Verify overlay containers render
    expect(container.querySelector('[data-testid="viewport-overlay"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="viewport-info"]')).toBeTruthy()
  })

  it('renders all 4 viewport control buttons with correct titles', () => {
    const { container } = render(<ModelViewer />)
    const overlay = container.querySelector('[data-testid="viewport-overlay"]')!
    const buttons = overlay.querySelectorAll('button')
    expect(buttons).toHaveLength(4)

    const titles = Array.from(buttons).map((btn) => btn.getAttribute('title'))
    expect(titles).toEqual(['Zoom In', 'Zoom Out', 'Reset View', 'Fit to View'])
  })

  it('renders button symbols matching the wireframe', () => {
    const { container } = render(<ModelViewer />)
    const overlay = container.querySelector('[data-testid="viewport-overlay"]')!
    const buttons = overlay.querySelectorAll('button')
    const symbols = Array.from(buttons).map((btn) => btn.textContent)
    expect(symbols).toEqual(['+', '−', '⟲', '⊞'])
  })

  it('shows model name chip when activeModel is set in workspace store', () => {
    useWorkspaceStore.setState({
      activeModel: {
        id: 'test-1',
        name: 'Headphone Wall Hook.stl',
        path: '/tmp/test.stl',
        source: 'makerworld',
        sizeBytes: 1024,
      },
    })

    const { container } = render(<ModelViewer />)
    const modelChip = container.querySelector('[data-testid="chip-model"]')
    expect(modelChip).toBeTruthy()
    expect(modelChip!.textContent).toContain('Model')
    expect(modelChip!.textContent).toContain('Headphone Wall Hook.stl')
  })

  it('does not show model chip when no activeModel', () => {
    const { container } = render(<ModelViewer />)
    expect(container.querySelector('[data-testid="chip-model"]')).toBeNull()
  })

  it('does not show size chip when no dimensions available', () => {
    const { container } = render(<ModelViewer />)
    expect(container.querySelector('[data-testid="chip-size"]')).toBeNull()
  })

  it('supports explicit modelPath prop for direct usage', () => {
    const { container } = render(<ModelViewer modelPath="/tmp/test.stl" />)
    expect(container.querySelector('[data-testid="model-viewer-container"]')).toBeTruthy()
    // Should still have overlay elements
    expect(container.querySelector('[data-testid="viewport-overlay"]')).toBeTruthy()
  })

  it('exports useModelLoader hook', () => {
    expect(typeof useModelLoader).toBe('function')
  })
})
