import { type ComponentType, type ReactNode, useRef } from 'react'
import type { AppState, Setup } from '../../sidecar/src/protocol'
import { sidecar } from './api'
import SetupCheck from './SetupCheck'
import SetupModel from './SetupModel'
import SetupReady from './SetupReady'

/** What every step's screen gets. `signIn` is a running sign-in's question, and `signIns` counts finished sign-ins. */
export type StepProps = { next: () => Promise<void>; back: () => Promise<void>; onError: (message: string) => void; signIn: ReactNode; signIns: number }

const STEPS: readonly { step: Setup['step']; name: string; numbered: boolean; Screen: ComponentType<StepProps> }[] = [
  { step: 'welcome', name: 'Welcome', numbered: false, Screen: Welcome },
  { step: 'check', name: 'Check your Mac', numbered: true, Screen: SetupCheck },
  { step: 'model', name: 'Pick a model', numbered: true, Screen: SetupModel },
  { step: 'ready', name: 'Ready', numbered: false, Screen: SetupReady },
]
const NUMBERED = STEPS.filter((entry) => entry.numbered)

type Props = Omit<StepProps, 'next' | 'back'> & {
  setup: Setup
  /** The app's state once a step change is saved. */
  onSaved: (state: AppState) => void
  error: ReactNode
}

/** First-launch setup, on the step the store keeps, until it is done. A step this build lacks starts it over. */
export default function SetupFlow({ setup, onSaved, error, ...shared }: Props) {
  const at = Math.max(0, STEPS.findIndex((entry) => entry.step === setup.step))
  const { step, name, numbered, Screen } = STEPS[at]
  const following = STEPS[at + 1]
  const before = STEPS[at - 1]
  const saving = useRef(false)
  const save = async (change: Setup) => {
    if (saving.current) return
    saving.current = true
    await sidecar('setup.set', change)
      .then(onSaved)
      .catch((err: unknown) => shared.onError(String(err)))
      .finally(() => {
        saving.current = false
      })
  }
  const next = () => save(following === undefined ? { step, done: true } : { step: following.step, done: false })
  const back = async () => {
    if (before !== undefined) await save({ step: before.step, done: false })
  }

  return (
    <main className="setup" data-testid="setup">
      {error}
      <section className="setup-card" aria-label={name}>
        {numbered && (
          <ol className="setup-steps">
            {NUMBERED.map((entry, index) => (
              <li key={entry.step} aria-current={entry.step === step ? 'step' : undefined}>
                <span>{index + 1}</span> {entry.name}
              </li>
            ))}
          </ol>
        )}
        <Screen next={next} back={back} {...shared} />
      </section>
    </main>
  )
}

function Welcome({ next }: StepProps) {
  return (
    <>
      <h1>Let’s get your Mac ready</h1>
      <p>
        Materialize 3D runs an AI agent on your Mac. It designs your part, shows it to you, and makes a print-ready 3MF.
        Setup checks what’s installed and takes about a minute.
      </p>
      <p className="setup-note">Your projects stay on your Mac. Your messages go only to the AI model you sign in to.</p>
      <div className="setup-actions">
        <button type="button" className="primary" onClick={next}>
          Start setup
        </button>
      </div>
    </>
  )
}
