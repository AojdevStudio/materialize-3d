import { useEffect, useState } from 'react'
import Markdown from './Markdown'
import { type Action, STOPPED, type ToolItem, type TraceItem } from './transcript'
import circleCheck from '../assets/icons/circle-check.svg?raw'
import circleX from '../assets/icons/circle-x.svg?raw'
import filePen from '../assets/icons/file-pen-line.svg?raw'
import fileText from '../assets/icons/file-text.svg?raw'
import layers from '../assets/icons/layers.svg?raw'
import messageSquare from '../assets/icons/message-square.svg?raw'
import terminal from '../assets/icons/terminal.svg?raw'

const ICONS: Record<Action, string> = { read: fileText, write: filePen, run: terminal, slice: layers, helper: messageSquare, other: '' }

/** A line icon from `src/assets/icons`, drawn in the line's color. */
const Icon = ({ svg }: { svg: string }) => <span className="trace-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />

/** The running mark: a still ring, as the sidebar's, since a spinning one repaints without end. */
const Ring = () => (
  <svg className="trace-icon trace-ring" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
    <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
  </svg>
)

/** Time as a clock shows it: 0:39, 14:05, or 1:02:05. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const ss = String(seconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

/** The time since `startedMs`, read again each second. None without a start. */
function useElapsed(startedMs: number | undefined): string | undefined {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startedMs === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedMs])
  return startedMs === undefined ? undefined : clock(now - startedMs)
}

/** The line a running turn shows before its first step. */
export function Working({ startedMs }: { startedMs: number | undefined }) {
  const time = useElapsed(startedMs)
  return (
    <p className="trace-head" data-testid="working">
      <Ring />
      <span>Working{time !== undefined && ` for ${time}`}</span>
    </p>
  )
}

type StepState = 'running' | 'done' | 'failed' | 'stopped'

function stateOf(step: ToolItem): StepState {
  if (step.result === undefined) return 'running'
  if (step.result === STOPPED) return 'stopped'
  return step.failed ? 'failed' : 'done'
}

/** A step's action in the past tense once it ended, and in the present while it runs or when it stopped part way. */
function actionOf(step: ToolItem): string {
  const state = stateOf(step)
  return state === 'done' || state === 'failed' ? step.label : step.doing
}

/** Says a step that ended badly failed or stopped. Nothing for one that runs or is done. */
function Flag({ step }: { step: ToolItem }) {
  const state = stateOf(step)
  return state === 'failed' || state === 'stopped' ? <span className={`step-flag flag-${state}`}>{state}</span> : null
}

function StepLine({ step }: { step: ToolItem }) {
  return (
    <li className={`trace-step step-${stateOf(step)}`}>
      <details>
        <summary>
          <Icon svg={ICONS[step.action]} />
          <span className="step-action">{actionOf(step)}</span>
          {step.summary !== '' && <span className="step-target">{step.summary}</span>}
          <Flag step={step} />
        </summary>
        <pre>{step.detail}</pre>
        {step.result !== undefined && <pre className="step-result">{step.result.slice(0, 4000)}</pre>}
      </details>
    </li>
  )
}

/**
 * A turn's steps, open at first. Its head folds them to one summary line and opens them again. While the turn runs the
 * head shows how long it has worked, counted from `startedMs`.
 */
export default function Trace({ trace, startedMs, onError }: { trace: TraceItem; startedMs: number | undefined; onError: (message: string) => void }) {
  const [open, setOpen] = useState(true)
  const time = useElapsed(trace.running ? startedMs : undefined)
  const steps = trace.lines.filter((line) => line.kind === 'tool')
  const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  // A trace starts with its first step, so it always has one.
  const last = steps[steps.length - 1]
  const stopped = steps.some((step) => step.result === STOPPED)

  const head = !trace.running ? (
    <>
      <Icon svg={stopped ? circleX : circleCheck} />
      <span>{stopped ? 'Stopped' : 'Done'}</span>
      <span className="trace-count">{count}</span>
    </>
  ) : open ? (
    <>
      <Ring />
      <span>Working{time !== undefined && ` for ${time}`}</span>
      <span className="trace-count">{count}</span>
    </>
  ) : (
    // Folded while it runs: the latest step stands for the rest.
    <>
      <Icon svg={ICONS[last.action]} />
      <span>{actionOf(last)}</span>
      <Flag step={last} />
      <span className="trace-count">{time === undefined ? count : `${count}, ${time}`}</span>
    </>
  )

  return (
    <div className={`trace${trace.running ? ' trace-running' : ''}`} data-testid="trace">
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid={trace.running ? 'working' : undefined}
      >
        {head}
        <svg className="trace-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="trace-lines">
          {trace.lines.map((line, i) =>
            line.kind === 'tool' ? (
              <StepLine key={line.id} step={line} />
            ) : (
              <li key={i} className="trace-note">
                <Markdown text={line.text} onError={onError} />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}
