import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { EventCallback, UnlistenFn } from '@tauri-apps/api/event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_DEFAULT_STATE, usePrintHistoryEvents, usePrintHistoryStore, type PrintHistoryRecord } from '../stores/printHistory'

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const savedRecord: PrintHistoryRecord = {
  id: 'persisted-print', modelName: 'Saved model', gcodeFile: null,
  startedAt: null, completedAt: '2026-03-15T09:15:00Z', durationSeconds: null,
  status: 'success', failReason: null, filamentGrams: null, filamentMeters: null,
  thumbnailPath: null, qualityProfile: null,
}

describe('print history startup', () => {
  let onHistoryChanged: EventCallback<PrintHistoryRecord[]>

  beforeEach(() => {
    usePrintHistoryStore.setState(HISTORY_DEFAULT_STATE)
    invokeMock.mockReset().mockResolvedValue([savedRecord])
    listenMock.mockReset().mockImplementation(async (_event: string, callback: typeof onHistoryChanged) => {
      onHistoryChanged = callback
      return () => {}
    })
  })

  afterEach(cleanup)

  it('loads persisted history after the event subscription is ready', async () => {
    const subscription = deferred<UnlistenFn>()
    listenMock.mockReturnValue(subscription.promise)
    renderHook(usePrintHistoryEvents)

    expect(listenMock).toHaveBeenCalledWith('history:changed', expect.any(Function))
    expect(invokeMock).not.toHaveBeenCalled()
    await act(async () => subscription.resolve(vi.fn()))

    await waitFor(() => expect(usePrintHistoryStore.getState().records).toEqual([savedRecord]))
    expect(invokeMock).toHaveBeenCalledWith('get_print_history')
  })

  it.each([{ records: [] }, { records: [{ ...savedRecord, id: 'new-print' }, savedRecord] }])(
    'keeps a newer event snapshot while the initial read is pending, case %#',
    async ({ records }) => {
      const initialRead = deferred<PrintHistoryRecord[]>()
      invokeMock.mockReturnValue(initialRead.promise)
      renderHook(usePrintHistoryEvents)
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_print_history'))

      act(() => onHistoryChanged({ event: 'history:changed', id: 1, payload: records }))
      await act(async () => initialRead.resolve([savedRecord]))

      expect(usePrintHistoryStore.getState().records).toEqual(records)
    },
  )

  it('releases a subscription that finishes after unmount without starting a read', async () => {
    const subscription = deferred<UnlistenFn>()
    const unlisten = vi.fn()
    listenMock.mockReturnValue(subscription.promise)
    const { unmount } = renderHook(usePrintHistoryEvents)
    unmount()
    await act(async () => subscription.resolve(unlisten))

    expect(unlisten).toHaveBeenCalledOnce()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('ignores an initial read that finishes after unmount', async () => {
    const initialRead = deferred<PrintHistoryRecord[]>()
    const unlisten = vi.fn()
    listenMock.mockResolvedValue(unlisten)
    invokeMock.mockReturnValue(initialRead.promise)
    const { unmount } = renderHook(usePrintHistoryEvents)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_print_history'))
    unmount()
    await act(async () => initialRead.resolve([savedRecord]))

    expect(unlisten).toHaveBeenCalledOnce()
    expect(usePrintHistoryStore.getState().records).toEqual([])
  })

  it('records a failed initial read and recovers when a history event arrives', async () => {
    invokeMock.mockRejectedValue('History database unavailable')
    renderHook(usePrintHistoryEvents)
    await waitFor(() => expect(usePrintHistoryStore.getState().loadError).toBe('History database unavailable'))

    act(() => onHistoryChanged({ event: 'history:changed', id: 1, payload: [savedRecord] }))

    expect(usePrintHistoryStore.getState().records).toEqual([savedRecord])
    expect(usePrintHistoryStore.getState().loadError).toBeNull()
  })
})
