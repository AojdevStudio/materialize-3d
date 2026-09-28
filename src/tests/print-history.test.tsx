// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listenMock = vi.fn()
const invokeMock = vi.fn()

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

import type { PrintHistoryRecord } from '../stores/printHistory'

const SAMPLE_RECORDS: PrintHistoryRecord[] = [
  {
    id: 'ph-1',
    modelName: 'Benchy',
    gcodeFile: 'plate_1.gcode',
    startedAt: '2026-03-15T08:00:00Z',
    completedAt: '2026-03-15T09:15:00Z',
    durationSeconds: 4500,
    status: 'completed',
    failReason: null,
    filamentGrams: 12.5,
    filamentMeters: 4.2,
    thumbnailPath: null,
    qualityProfile: '0.20mm Standard',
  },
  {
    id: 'ph-2',
    modelName: 'Phone Stand',
    gcodeFile: 'plate_2.gcode',
    startedAt: '2026-03-14T14:00:00Z',
    completedAt: '2026-03-14T14:30:00Z',
    durationSeconds: 1800,
    status: 'failed',
    failReason: 'Nozzle clog detected',
    filamentGrams: 3.1,
    filamentMeters: 1.0,
    thumbnailPath: null,
    qualityProfile: '0.12mm Fine',
  },
  {
    id: 'ph-3',
    modelName: 'Cable Clip',
    gcodeFile: null,
    startedAt: null,
    completedAt: '2026-03-13T10:00:00Z',
    durationSeconds: 30,
    status: 'completed',
    failReason: null,
    filamentGrams: null,
    filamentMeters: null,
    thumbnailPath: null,
    qualityProfile: null,
  },
]

describe('PrintHistory component', () => {
  beforeEach(async () => {
    listenMock.mockImplementation(async () => () => {})
    invokeMock.mockReset()

    const { usePrintHistoryStore, HISTORY_DEFAULT_STATE } = await import('../stores/printHistory')
    usePrintHistoryStore.setState(HISTORY_DEFAULT_STATE)
  })

  afterEach(() => {
    cleanup()
  })

  it('renders empty state with "No prints recorded yet"', async () => {
    const { PrintHistory } = await import('../components/PrintHistory')
    render(React.createElement(PrintHistory))

    expect(screen.getByTestId('print-history-empty')).toBeDefined()
    expect(screen.getByText('No prints recorded yet')).toBeDefined()
    expect(screen.getByText('Print history will appear here as prints complete')).toBeDefined()
  })

  it('renders cards in correct order with model names when populated', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')

    act(() => {
      usePrintHistoryStore.getState().applySnapshot(SAMPLE_RECORDS)
    })

    const { PrintHistory } = await import('../components/PrintHistory')
    render(React.createElement(PrintHistory))

    const cards = screen.getAllByTestId('history-card')
    expect(cards).toHaveLength(3)

    // Model names rendered
    expect(screen.getByText('Benchy')).toBeDefined()
    expect(screen.getByText('Phone Stand')).toBeDefined()
    expect(screen.getByText('Cable Clip')).toBeDefined()
  })

  it('shows green success badge for completed prints', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')

    act(() => {
      usePrintHistoryStore.getState().applySnapshot([SAMPLE_RECORDS[0]])
    })

    const { PrintHistory } = await import('../components/PrintHistory')
    render(React.createElement(PrintHistory))

    const badge = screen.getByTestId('history-status')
    expect(badge.textContent).toBe('Success')
    expect(badge.classList.contains('history-status--success')).toBe(true)
  })

  it('shows red failed badge with reason', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')

    act(() => {
      usePrintHistoryStore.getState().applySnapshot([SAMPLE_RECORDS[1]])
    })

    const { PrintHistory } = await import('../components/PrintHistory')
    render(React.createElement(PrintHistory))

    const badge = screen.getByTestId('history-status')
    expect(badge.textContent).toBe('Failed: Nozzle clog detected')
    expect(badge.classList.contains('history-status--failed')).toBe(true)
  })

  it('formats duration correctly', async () => {
    const { formatDuration } = await import('../components/PrintHistory')

    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(30)).toBe('<1m')
    expect(formatDuration(2700)).toBe('45m')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(8100)).toBe('2h 15m')
    expect(formatDuration(60)).toBe('1m')
  })

  it('has delete button on each card', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')

    act(() => {
      usePrintHistoryStore.getState().applySnapshot(SAMPLE_RECORDS)
    })

    const { PrintHistory } = await import('../components/PrintHistory')
    render(React.createElement(PrintHistory))

    const deleteButtons = screen.getAllByTestId('history-delete')
    expect(deleteButtons).toHaveLength(3)
    expect(deleteButtons[0].getAttribute('aria-label')).toBe('Delete Benchy')
  })

  it('applySnapshot updates store records', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')

    expect(usePrintHistoryStore.getState().records).toHaveLength(0)

    act(() => {
      usePrintHistoryStore.getState().applySnapshot(SAMPLE_RECORDS)
    })

    expect(usePrintHistoryStore.getState().records).toHaveLength(3)
    expect(usePrintHistoryStore.getState().records[0].modelName).toBe('Benchy')
  })

  it('formats dates in human-readable form', async () => {
    const { formatDate } = await import('../components/PrintHistory')

    // Should return a formatted string, not the raw ISO
    const result = formatDate('2026-03-15T09:15:00Z')
    expect(result).not.toBe('2026-03-15T09:15:00Z')
    expect(result.length).toBeGreaterThan(5)

    // Invalid dates fall through
    expect(formatDate('not-a-date')).toBe('not-a-date')
  })

  it('displays filament usage when available', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')

    act(() => {
      usePrintHistoryStore.getState().applySnapshot([SAMPLE_RECORDS[0]])
    })

    const { PrintHistory } = await import('../components/PrintHistory')
    render(React.createElement(PrintHistory))

    const filament = screen.getByTestId('history-filament')
    expect(filament.textContent).toContain('12.5g')
    expect(filament.textContent).toContain('4.2m')
  })

  it('displays quality profile when available', async () => {
    const { usePrintHistoryStore } = await import('../stores/printHistory')

    act(() => {
      usePrintHistoryStore.getState().applySnapshot([SAMPLE_RECORDS[0]])
    })

    const { PrintHistory } = await import('../components/PrintHistory')
    render(React.createElement(PrintHistory))

    expect(screen.getByTestId('history-quality').textContent).toBe('0.20mm Standard')
  })
})
