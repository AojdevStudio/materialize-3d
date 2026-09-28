import { emit } from '@tauri-apps/api/event'
import type { ToolCallMessagePartComponent, ToolCallMessagePartProps } from '@assistant-ui/react'
import type { BuildStep } from '../../types/agent'
import { BUILD_STEPS, type ToolArtifact } from './agentAdapter'
import styles from './ChatPanel.module.css'

/** build_sign's output: mirror of `SignSummary` in src-tauri/src/actions.rs (fields the chat reads). */
interface SignSummary {
  revision_id: string
  number: number
  title: string
  build: 'building' | 'verified' | 'failed'
  failure_reason?: string | null
  checks_passed: number
  checks_total: number
  failed_checks: string[]
  package_sha256: string | null
  approval: 'pending' | 'approved' | 'void'
  reused: boolean
}

type CallState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

const STEP_LABELS: Record<BuildStep, string> = {
  spec_validated: 'Spec validated',
  geometry_built: 'Geometry built',
  package_written: 'Package written',
  sliced: 'Sliced',
  verified: 'Verified',
}

/**
 * One reading of a call's state. A live Stop shows up as the part's
 * incomplete status; calls restored from history carry their outcome in the
 * artifact and always hold a result.
 */
function callState({ artifact, result, isError, status }: ToolCallMessagePartProps): CallState {
  const outcome = (artifact as ToolArtifact | undefined)?.outcome
  if (outcome) return outcome
  if (result !== undefined) return isError ? 'failed' : 'done'
  if (status.type === 'running' || status.type === 'requires-action') return 'running'
  if (status.type === 'incomplete') return status.reason === 'cancelled' ? 'cancelled' : 'failed'
  return 'interrupted'
}

const stepsOf = (artifact: unknown): BuildStep[] => (artifact as ToolArtifact | undefined)?.steps ?? []

function errorText(result: unknown): string {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'error' in result) return String((result as { error: unknown }).error)
  return 'The tool reported an error.'
}

const shortHash = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`

const openRevision = (revisionId: string) => void emit('signs:open', { revisionId })

/** Result of a finished build_sign. There is deliberately no approve control here. */
function SignResult({ sign }: { sign: SignSummary }) {
  const allPassed = sign.checks_total > 0 && sign.checks_passed === sign.checks_total
  return (
    <table className={styles.result} data-testid="tool-result">
      <tbody>
        <tr>
          <th>Revision</th>
          <td>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                openRevision(sign.revision_id)
              }}
            >
              r{sign.number}
            </a>
            , {sign.title}
            {sign.reused && <span className={styles.muted}> (unchanged, reused)</span>}
          </td>
        </tr>
        {sign.build === 'failed' ? (
          <tr>
            <th>Build</th>
            <td className={styles.bad}>Failed{sign.failure_reason ? `: ${sign.failure_reason}` : ''}</td>
          </tr>
        ) : (
          <tr>
            <th>Verified</th>
            <td>
              <span className={allPassed ? styles.ok : styles.bad}>
                {sign.checks_passed} of {sign.checks_total} checks
              </span>
              {sign.failed_checks.map((check) => (
                <div key={check} className={styles.bad}>
                  {check}
                </div>
              ))}
            </td>
          </tr>
        )}
        {sign.package_sha256 && (
          <tr>
            <th>Package</th>
            <td>
              <code title={sign.package_sha256}>{shortHash(sign.package_sha256)}</code>
            </td>
          </tr>
        )}
        <tr>
          <th>Approval</th>
          <td>
            {sign.approval === 'pending' ? (
              <>
                <b>Awaiting your approval</b> <span className={styles.muted}>(the assistant cannot approve)</span>
              </>
            ) : sign.approval === 'approved' ? (
              'Approved'
            ) : (
              <span className={styles.bad}>Void, the package changed after approval</span>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

const STEP_STATE_TEXT = { done: 'done', running: 'running', waiting: 'waiting', stopped: 'stopped', skipped: 'skipped' } as const
type StepState = keyof typeof STEP_STATE_TEXT

function stepState(index: number, completed: number, state: CallState): StepState {
  if (index < completed) return 'done'
  if (state === 'running') return index === completed ? 'running' : 'waiting'
  return index === completed ? 'stopped' : 'skipped'
}

/** build_sign: numbered steps while running, one line plus the result once finished. */
export const BuildSignTool: ToolCallMessagePartComponent = (props) => {
  const state = callState(props)
  const steps = stepsOf(props.artifact)
  const total = BUILD_STEPS.length
  const summary =
    state === 'running'
      ? `${steps.length} of ${total} steps`
      : state === 'done'
        ? `${total} of ${total} steps`
        : state === 'cancelled'
          ? steps.length > 0
            ? `Cancelled after ${steps.length} of ${total} steps`
            : 'Cancelled'
          : state === 'interrupted'
            ? 'Interrupted, the app closed while it ran'
            : 'Failed'
  const showSteps = state === 'running' || (state === 'cancelled' && steps.length > 0)
  const sign = state === 'done' ? (props.result as SignSummary) : null

  return (
    <div className={styles.tool} data-testid="tool-build-sign" data-state={state}>
      <div className={styles.toolHead}>
        <span className={styles.mono}>build_sign</span>
        <span className={state === 'done' ? styles.ok : state === 'failed' ? styles.bad : styles.muted}>{summary}</span>
      </div>
      {showSteps && (
        <ol className={styles.steps} data-testid="tool-steps">
          {BUILD_STEPS.map((step, index) => {
            const s = stepState(index, steps.length, state)
            return (
              <li key={step} className={styles[`step_${s}`]}>
                <span className={styles.stepState}>{STEP_STATE_TEXT[s]}</span>
                <span>
                  <span className={styles.dim}>{index + 1}. </span>
                  {STEP_LABELS[step]}
                </span>
              </li>
            )
          })}
        </ol>
      )}
      {state === 'failed' && props.result !== undefined && <div className={styles.bad}>{errorText(props.result)}</div>}
      {sign && <SignResult sign={sign} />}
    </div>
  )
}

const LINE_TEXT: Record<CallState, string> = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
}

/** Every other tool (list_signs, get_sign, show_sign, printer_status, unknown): one status line. */
export const ToolLine: ToolCallMessagePartComponent = (props) => {
  const state = callState(props)
  return (
    <div className={styles.tool} data-state={state}>
      <div className={styles.toolHead}>
        <span className={styles.mono}>{props.toolName}</span>
        <span className={state === 'done' ? styles.ok : state === 'failed' ? styles.bad : styles.muted}>{LINE_TEXT[state]}</span>
      </div>
      {state === 'failed' && props.result !== undefined && <div className={styles.bad}>{errorText(props.result)}</div>}
    </div>
  )
}
