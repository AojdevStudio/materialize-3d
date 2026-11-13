import { type ComponentType, type ReactNode, useRef } from 'react'
import type { AppState, Setup } from '../../sidecar/src/protocol'
import { sidecar } from './api'
import SetupCheck from './SetupCheck'

/**
 * What every step's screen gets. `signIn` is a running sign-in's question, and `signIns` counts finished sign-ins.
 * `refused` is the provider a waiting turn needs a new sign-in to.
 */
export type StepProps = { next: () => void; onError: (message: string) => void; signIn: ReactNode; signIns: number; refused?: string }

const STEPS: readonly { step: Setup['step']; name?: string; Screen: ComponentType<StepProps> }[] = [
  { step: 'welcome', Screen: Welcome },
  { step: 'check', name: 'Check your Mac', Screen: SetupCheck },
]

type Shared = Omit<StepProps, 'next'> & { error: ReactNode }

const indexOf = (step: Setup['step']) => Math.max(0, STEPS.findIndex((entry) => entry.step === step))

/** First-launch setup, on the step the store keeps, until it is done. A step this build lacks starts it over. */
export default function SetupFlow({ setup, onSaved, ...shared }: Shared & { setup: Setup; onSaved: (state: AppState) => void }) {
  const at = indexOf(setup.step)
  const { step } = STEPS[at]
  const following = STEPS[at + 1]
  const saving = useRef(false)
  const next = () => {
    if (saving.current) return
    saving.current = true
    void sidecar('setup.set', following === undefined ? { step, done: true } : { step: following.step, done: false })
      .then(onSaved)
      .catch((err: unknown) => shared.onError(String(err)))
      .finally(() => {
        saving.current = false
      })
  }

  return <SetupCard at={at} next={next} {...shared} />
}

/** One step of setup opened again, as Fix in setup does. Going on, or Back, ends it there. The stored setup stays done. */
export function SetupStep({ step, onDone, ...shared }: Shared & { step: Setup['step']; onDone: () => void }) {
  return <SetupCard at={indexOf(step)} next={onDone} back={onDone} {...shared} />
}

function SetupCard({ at, next, back, error, ...shared }: Shared & { at: number; next: () => void; back?: () => void }) {
  const { step, name, Screen } = STEPS[at]
  return (
    <main className="setup" data-testid="setup">
      {error}
      {back !== undefined && (
        <div className="setup-back">
          <button type="button" onClick={back}>
            Back
          </button>
        </div>
      )}
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
