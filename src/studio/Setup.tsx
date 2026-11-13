import { type ComponentType, type ReactNode, useRef } from 'react'
import type { AppState, Setup } from '../../sidecar/src/protocol'
import { sidecar } from './api'
import SetupCheck from './SetupCheck'
import SetupModel from './SetupModel'
import SetupReady from './SetupReady'

/**
 * What every step's screen gets. `signIn` is a running sign-in's question, and `signIns` counts finished sign-ins.
 * `refused` is the provider a waiting turn needs a new sign-in to.
 */
export type StepProps = {
  next: () => Promise<void>
  back: () => Promise<void>
  onError: (message: string) => void
  signIn: ReactNode
  signIns: number
  refused?: string
}

const STEPS: readonly { step: Setup['step']; name: string; numbered: boolean; Screen: ComponentType<StepProps> }[] = [
  { step: 'welcome', name: 'Welcome', numbered: false, Screen: Welcome },
  { step: 'check', name: 'Check your Mac', numbered: true, Screen: SetupCheck },
  { step: 'model', name: 'Pick a model', numbered: true, Screen: SetupModel },
  { step: 'ready', name: 'Ready', numbered: false, Screen: SetupReady },
]
const NUMBERED = STEPS.filter((entry) => entry.numbered)

type Shared = Omit<StepProps, 'next' | 'back'> & { error: ReactNode }

const indexOf = (step: Setup['step']) => Math.max(0, STEPS.findIndex((entry) => entry.step === step))

/** First-launch setup, on the step the store keeps, until it is done. A step this build lacks starts it over. */
export default function SetupFlow({ setup, onSaved, ...shared }: Shared & { setup: Setup; onSaved: (state: AppState) => void }) {
  const at = indexOf(setup.step)
  const { step } = STEPS[at]
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

  return <SetupCard at={at} next={next} back={back} reopened={false} {...shared} />
}

/** One step of setup opened again, as Fix in setup does. Going on, or Back, ends it there. The stored setup stays done. */
export function SetupStep({ step, onDone, ...shared }: Shared & { step: Setup['step']; onDone: (wentOn: boolean) => void }) {
  return <SetupCard at={indexOf(step)} next={async () => onDone(true)} back={async () => onDone(false)} reopened {...shared} />
}

/** A reopened step gets a Back above the card, since the flow's own steps around it are done. */
function SetupCard({ at, next, back, reopened, error, ...shared }: Shared & Pick<StepProps, 'next' | 'back'> & { at: number; reopened: boolean }) {
  const { step, name, numbered, Screen } = STEPS[at]
  return (
    <main className="setup" data-testid="setup">
      {error}
      {reopened && (
        <div className="setup-back">
          <button type="button" onClick={back}>
            Back
          </button>
        </div>
      )}
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
