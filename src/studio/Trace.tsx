import { useEffect, useState } from 'react'
import Markdown from './Markdown'
import type { Action, ToolItem, TraceItem } from './transcript'
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

/** The mark of a trace that ended: a plain circle, as the sidebar marks a draft, since the entries cannot say it succeeded. */
const Ended = () => (
  <svg className="trace-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeWidth={1.5} />
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

/**
 * The time since `startedMs` after `before`, read again each second. It keeps the clock to itself, so a tick redraws
 * this text and not the lines around it. Nothing without a start.
 */
function Since({ startedMs, before }: { startedMs: number | undefined; before: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startedMs === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedMs])
  return startedMs === undefined ? null : `${before}${clock(now - startedMs)}`
}

/** The ring and how long the turn has worked, as a running turn's head says it. */
const Busy = ({ startedMs }: { startedMs: number | undefined }) => (
  <>
    <Ring />
    <span>
      Working<Since startedMs={startedMs} before=" for " />
    </span>
  </>
)

/** The line a running turn shows before its first step. */
export function Working({ startedMs }: { startedMs: number | undefined }) {
  return (
    <p className="trace-head" data-testid="working">
      <Busy startedMs={startedMs} />
    </p>
  )
}

/** A step's action in the past tense once it ended, and in the present while it runs or when it stopped part way. */
const actionOf = (step: ToolItem) => (step.state === 'done' || step.state === 'failed' ? step.label : step.doing)

/** Says a step that ended badly failed or stopped. Nothing for one that runs or is done. */
function Flag({ step }: { step: ToolItem }) {
  return step.state === 'failed' || step.state === 'stopped' ? <span className={`step-flag flag-${step.state}`}>{step.state}</span> : null
}

function StepLine({ step }: { step: ToolItem }) {
  return (
    <li className={`trace-step step-${step.state}`}>
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
 * head shows how long it has worked, counted from `startedMs`. Once it ended, the head says only what the steps hold:
 * it worked, or it stopped part way through a step. The entries cannot tell a finished turn from one that failed or
 * waits, so the head never says done.
 */
export default function Trace({ trace, startedMs, onError }: { trace: TraceItem; startedMs: number | undefined; onError: (message: string) => void }) {
  const [open, setOpen] = useState(true)
  const { running } = trace
  const steps = trace.lines.filter((line) => line.kind === 'tool')
  const count = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`
  const stopped = steps.some((step) => step.state === 'stopped')
  // Folded while it runs, a step that still runs stands for the rest, or else the latest. A trace starts with its first
  // step, so it always has one.
  const shown = [...steps].reverse().find((step) => step.state === 'running') ?? steps[steps.length - 1]

  const head = !running ? (
    <>
      {stopped ? <Icon svg={circleX} /> : <Ended />}
      <span>{stopped ? 'Stopped' : 'Worked'}</span>
      <span className="trace-count">{count}</span>
    </>
  ) : open ? (
    <>
      <Busy startedMs={startedMs} />
      <span className="trace-count">{count}</span>
    </>
  ) : (
    <>
      <Icon svg={ICONS[shown.action]} />
      <span>{actionOf(shown)}</span>
      <Flag step={shown} />
      <span className="trace-count">
        {count}
        <Since startedMs={startedMs} before=", " />
      </span>
    </>
  )

  return (
    <div className={`trace${running ? ' trace-running' : ''}`} data-testid="trace">
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid={running ? 'working' : undefined}
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
