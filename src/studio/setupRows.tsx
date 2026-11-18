import { type ReactNode, useEffect, useState } from 'react'
import type { ModelOption } from '../../sidecar/src/protocol'
import { checkSlicer, sidecar } from './api'
import type { Found, Row } from './checkRows'
import { Mark } from './marks'

/**
 * Asks the sign-ins, the slicer, and the build tools, and fills each part as it answers. A new `round` asks all three
 * again from blank. A new `signIns` asks only the sign-ins again.
 */
export function useFound(onError: (message: string) => void, signIns: number, round = 0): Found {
  const [found, setFound] = useState<Found>({})

  const fill = <K extends keyof Found>(part: K, answer: Promise<Exclude<Found[K], 'failed' | undefined>>, current: () => boolean) =>
    void answer.then(
      (value) => current() && setFound((now) => ({ ...now, [part]: value })),
      (err: unknown) => {
        if (!current()) return
        setFound((now) => ({ ...now, [part]: 'failed' }))
        onError(String(err))
      },
    )

  useEffect(() => {
    let current = true
    setFound({})
    fill('toolchain', sidecar('setup.tools', {}), () => current)
    fill('slicer', checkSlicer(), () => current)
    return () => {
      current = false
    }
  }, [round])

  useEffect(() => {
    let current = true
    fill('logins', sidecar('auth.status', {}), () => current)
    return () => {
      current = false
    }
  }, [round, signIns])

  return found
}

export function CheckGroup({ title, rows, testId, act, children }: { title: string; rows: Row[]; testId: 'check' | 'settings'; act: (row: Row) => ReactNode; children?: ReactNode }) {
  return (
    <section className="setup-group" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="setup-row" data-status={row.status} data-testid={`${testId}-${row.id}`}>
            <span className="setup-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: row.icon }} />
            <span className="setup-what">
              <span className="setup-name">{row.name}</span>
              <span className="setup-detail">{row.detail}</span>
            </span>
            <span className="setup-act">{act(row)}</span>
            <span className="setup-status">{row.label}</span>
          </li>
        ))}
      </ul>
      {children}
    </section>
  )
}

export function ModelRow({ model, className, name, checked, onPick }: { model: ModelOption; className: string; name: string; checked: boolean; onPick: () => void }) {
  return (
    <label className={className}>
      <input type="radio" name={name} checked={checked} onChange={onPick} />
      <Mark modelId={model.modelId} />
      <span className="setup-what">
        <span className="setup-name">{model.name}</span>
        <span className="setup-detail">{model.description}</span>
      </span>
    </label>
  )
}

export function AstraSwitch({ id, signedIn, on, busy, onChange }: { id: string; signedIn: boolean; on: boolean; busy: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="setup-switch">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={signedIn && on}
        disabled={!signedIn || busy}
        aria-describedby={signedIn ? undefined : `${id}-needs`}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={id}>Let the main agent ask GPT (Astra) for drawings</label>
      {!signedIn && (
        <span id={`${id}-needs`} className="setup-detail">
          Needs a ChatGPT sign-in.
        </span>
      )}
    </div>
  )
}
