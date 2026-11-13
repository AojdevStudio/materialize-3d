import type { ComponentType, ReactNode } from 'react'
import type { AppState, Setup } from '../../sidecar/src/protocol'
import { sidecar } from './api'
import SetupCheck from './SetupCheck'

/** What every step's screen gets. `signIn` is a running sign-in's question, and `signIns` counts finished sign-ins. */
export type StepProps = { next: () => void; onError: (message: string) => void; signIn: ReactNode; signIns: number }

const STEPS: readonly { step: Setup['step']; name?: string; Screen: ComponentType<StepProps> }[] = [
  { step: 'welcome', Screen: Welcome },
  { step: 'check', name: 'Check your Mac', Screen: SetupCheck },
]

type Props = Omit<StepProps, 'next'> & {
  setup: Setup
  /** The app's state once a step change is saved. */
  onSaved: (state: AppState) => void
  error: ReactNode
}

/** First-launch setup, on the step the store keeps, until it is done. A step this build lacks starts it over. */
export default function SetupFlow({ setup, onSaved, error, ...shared }: Props) {
  const at = Math.max(0, STEPS.findIndex((entry) => entry.step === setup.step))
  const { step, name, Screen } = STEPS[at]
  const following = STEPS[at + 1]
  const next = () =>
    void sidecar('setup.set', following === undefined ? { step, done: true } : { step: following.step, done: false })
      .then(onSaved)
      .catch((err: unknown) => shared.onError(String(err)))

  return (
    <main className="setup" data-testid="setup">
      {error}
      <section className="setup-card" aria-label={name ?? 'Welcome'}>
        {name !== undefined && (
          <ol className="setup-steps">
            {STEPS.filter((entry) => entry.name !== undefined).map((entry, index) => (
              <li key={entry.step} aria-current={entry.step === step ? 'step' : undefined}>
                <span>{index + 1}</span> {entry.name}
              </li>
            ))}
          </ol>
        )}
        <Screen next={next} {...shared} />
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
