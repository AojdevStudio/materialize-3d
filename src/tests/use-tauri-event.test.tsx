import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const listenMock = vi.fn()
const unlistenMock = vi.fn()

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const { useTauriEvent } = await import('../hooks/useTauriEvent')

function Listener({ name }: { name: string }) {
  useTauriEvent(name, () => {})
  return null
}

describe('useTauriEvent', () => {
  afterEach(() => {
    cleanup()
    listenMock.mockReset()
    unlistenMock.mockReset()
  })

  it('listens while mounted and stops listening after unmount', async () => {
    listenMock.mockImplementation(async (name: string) => () => unlistenMock(name))
    const view = render(<Listener name="update:waiting" />)
    expect(listenMock).toHaveBeenCalledWith('update:waiting', expect.any(Function))
    await act(() => Promise.resolve())

    view.unmount()
    expect(unlistenMock).toHaveBeenCalledWith('update:waiting')
  })

  it('stops listening when it unmounts before the listener is registered', async () => {
    let register!: () => void
    listenMock.mockImplementation(
      (name: string) =>
        new Promise((resolve) => {
          register = () => resolve(() => unlistenMock(name))
        }),
    )
    const view = render(<Listener name="update:progress" />)
    view.unmount()
    expect(unlistenMock).not.toHaveBeenCalled()

    await act(async () => register())
    expect(unlistenMock).toHaveBeenCalledWith('update:progress')
  })
})
