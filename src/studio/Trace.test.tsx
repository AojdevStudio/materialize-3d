import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Trace, { clock } from './Trace'
import { STOPPED, type ToolItem, type TraceItem } from './transcript'

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

const write = (id: string, more: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', id, action: 'write', label: 'Wrote', doing: 'Writing', summary: `${id}.py`, detail: `${id}.py`, ...more,
})
const slice: ToolItem = { kind: 'tool', id: 's1', action: 'slice', label: 'Sliced', doing: 'Slicing', summary: 'print/grid.3mf', detail: '{}' }

const trace = (lines: TraceItem['lines'], running: boolean): TraceItem => ({ kind: 'trace', id: lines[0].kind === 'tool' ? lines[0].id : 'x', lines, running })
const head = () => screen.getByTestId('trace').querySelector('button') as HTMLButtonElement
/** What a reader sees, without the white space in the icons' markup. */
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Trace', () => {
  it('starts open, folds to one summary line, and opens again', () => {
    render(<Trace trace={trace([write('grid', { result: 'ok', failed: false }), slice], true)} startedMs={NOW - 39_000} onError={() => {}} />)
    expect(text(head())).toBe('Working for 0:392 steps')
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Wrote')).toBeTruthy()
    expect(screen.getByText('Slicing')).toBeTruthy()

    fireEvent.click(head())
    expect(head().getAttribute('aria-expanded')).toBe('false')
    // Folded, the latest step stands for the rest, with the count and the time.
    expect(text(head())).toBe('Slicing2 steps, 0:39')
    expect(screen.queryByText('Wrote')).toBeNull()
    expect(screen.queryByText('grid.py', { selector: '.step-target' })).toBeNull()

    act(() => vi.advanceTimersByTime(1000))
    expect(text(head())).toBe('Slicing2 steps, 0:40')

    fireEvent.click(head())
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Wrote')).toBeTruthy()
    expect(screen.getByText('grid.py', { selector: '.step-target' })).toBeTruthy()
  })

  it('keeps the latest step flagged on the summary line when it failed', () => {
    render(<Trace trace={trace([write('grid', { result: 'ok', failed: false }), { ...slice, result: 'no Bambu Studio', failed: true }], true)} startedMs={NOW - 23_000} onError={() => {}} />)
    fireEvent.click(head())
    expect(text(head())).toBe('Slicedfailed2 steps, 0:23')
  })

  it('says each step in the past tense once done and in the present while it runs', () => {
    render(
      <Trace
        trace={trace([write('done', { result: 'ok', failed: false }), write('failed', { result: 'disk full', failed: true }), write('running')], true)}
        startedMs={undefined}
        onError={() => {}}
      />,
    )
    const line = (target: string) => text(screen.getByText(target, { selector: '.step-target' }).closest('summary'))
    expect(line('done.py')).toBe('Wrotedone.py')
    expect(line('failed.py')).toBe('Wrotefailed.pyfailed')
    expect(line('running.py')).toBe('Writingrunning.py')
    expect(text(head())).toBe('Working3 steps')
  })

  it('says a finished turn is done, and one stopped part way is stopped, with its step in the present', () => {
    const { unmount } = render(<Trace trace={trace([write('a', { result: 'ok', failed: false })], false)} startedMs={NOW - 5000} onError={() => {}} />)
    expect(text(head())).toBe('Done1 step')
    unmount()
    render(<Trace trace={trace([write('a', { result: 'ok', failed: false }), write('b', { result: STOPPED, failed: true })], false)} startedMs={undefined} onError={() => {}} />)
    expect(text(head())).toBe('Stopped2 steps')
    expect(text(screen.getByText('b.py', { selector: '.step-target' }).closest('summary'))).toBe('Writingb.pystopped')
  })

  it('keeps what the agent said between steps in its place', () => {
    render(<Trace trace={trace([write('a', { result: 'ok', failed: false }), { kind: 'note', text: 'Now the **print** file.' }, slice], true)} startedMs={undefined} onError={() => {}} />)
    const lines = screen.getAllByRole('listitem').map((li) => text(li.querySelector('summary') ?? li))
    expect(lines).toEqual(['Wrotea.py', 'Now the print file.', 'Slicingprint/grid.3mf'])
    expect(screen.getByText('print').tagName).toBe('STRONG')
  })
})

describe('clock', () => {
  it('reads like a clock', () => {
    expect(clock(39_000)).toBe('0:39')
    expect(clock(14 * 60_000 + 5000)).toBe('14:05')
    expect(clock(3_725_000)).toBe('1:02:05')
    expect(clock(-2000)).toBe('0:00')
  })
})
