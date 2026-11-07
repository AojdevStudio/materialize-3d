// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: vi.fn().mockResolvedValue(() => {}) }),
}))

import StudioApp from './StudioApp'

// jsdom has no layout, so the chat's scroll to its newest line is a no-op here.
Element.prototype.scrollIntoView = vi.fn()

const projectB = { id: '2026-11-06-b', title: 'Project B', createdMs: 1, path: '/p/b' }

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
})

function mockStudio(overrides: Record<string, () => Promise<unknown>>) {
  invokeMock.mockImplementation((command: string) => {
    if (command in overrides) return overrides[command]()
    switch (command) {
      case 'studio_projects':
        return Promise.resolve([projectB])
      case 'studio_transcript':
      case 'studio_files':
        return Promise.resolve([])
      case 'update_check':
        return Promise.resolve({ status: 'upToDate' })
      default:
        return Promise.resolve(undefined)
    }
  })
}

describe('StudioApp', () => {
  it('leaves the project the person moved to alone when a slow send from the start screen finishes', async () => {
    let finishCreate: (project: unknown) => void = () => {}
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case 'studio_projects':
          return Promise.resolve([projectB])
        case 'studio_create_project':
          return new Promise((resolve) => (finishCreate = resolve))
        case 'studio_transcript':
        case 'studio_files':
          return Promise.resolve([])
        case 'update_check':
          return Promise.resolve({ status: 'upToDate' })
        default:
          return Promise.resolve(undefined)
      }
    })
    render(<StudioApp />)
    await screen.findByText('Project B')

    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'A clip for my desk' } })
    fireEvent.click(screen.getByTestId('send'))
    fireEvent.click(screen.getByText('Project B'))
    await screen.findByRole('banner')
    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'draft for B' } })

    await act(async () => finishCreate({ id: '2026-11-06-a-clip', title: 'A clip for my desk', createdMs: 2, path: '/p/a' }))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('studio_send', expect.objectContaining({ project: '2026-11-06-a-clip' })))

    expect(screen.getByRole('banner').textContent).toBe('Project B')
    expect((screen.getByTestId('prompt') as HTMLTextAreaElement).value).toBe('draft for B')
  })

  it("keeps a slow send's failure with the project it was sent to", async () => {
    let failSend: (reason: string) => void = () => {}
    const projectA = { id: '2026-11-06-a', title: 'Project A', createdMs: 2, path: '/p/a' }
    mockStudio({
      studio_projects: () => Promise.resolve([projectA, projectB]),
      studio_send: () => new Promise((_, reject) => (failSend = reject)),
    })
    render(<StudioApp />)
    fireEvent.click(await screen.findByText('Project A'))
    await screen.findByRole('banner')
    fireEvent.change(screen.getByTestId('prompt'), { target: { value: 'A clip for my desk' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('studio_send', expect.objectContaining({ project: projectA.id })))
    fireEvent.click(screen.getByText('Project B'))
    await waitFor(() => expect(screen.getByRole('banner').textContent).toBe('Project B'))

    await act(async () => failSend('The agent could not start.'))
    expect(screen.queryByRole('alert')).toBeNull()

    fireEvent.click(screen.getByText('Project A'))
    expect((await screen.findByRole('alert')).textContent).toContain('The agent could not start.')
  })
})
