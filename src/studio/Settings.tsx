import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { type ReactNode, useEffect, useState } from 'react'
import type { AppState, Methods, ModelChoice, ModelOption, Settings as Saved, Setup } from '../../sidecar/src/protocol'
import { checkSlicer, projectsFolder, sidecar } from './api'
import { Mark } from './ModelPicker'
import { agentRows, buildRows, forgetRefused, type Found, type Row, slicerRow } from './SetupCheck'
import { astraSignedIn } from './SetupModel'

const ORDER = ['agents', 'slicer', 'tools', 'folder'] as const
export type Section = (typeof ORDER)[number]

const SECTIONS: Record<Section, { name: string; about: string }> = {
  agents: { name: 'Agents and models', about: 'Who does the work, and the model new projects start with.' },
  slicer: { name: 'Slicer and printer', about: 'What makes the print-ready 3MF, and the printer it slices for.' },
  tools: { name: 'Build tools', about: 'What the agent builds and checks your parts with.' },
  folder: { name: 'Projects folder', about: 'Each project is a folder here, with its parts, guides, and print files.' },
}

type Props = {
  section: Section
  onSection: (section: Section) => void
  /** The app reads these again after each sign-in. */
  models: ModelOption[]
  /** The app's state after a change saves, so the composer's picker shows the new default. */
  onSaved: (state: AppState) => void
  /** Opens the setup step that owns a fix. Settings shows again when it ends. */
  onFix: (step: Setup['step']) => void
  onClose: () => void
  onError: (message: string) => void
  error: ReactNode
  /** A sign-in question still open. Back in a setup step can leave one, so Settings shows it too. */
  signIn: ReactNode
  /** Counts finished sign-ins, so the sign-in rows read again after each. */
  signIns: number
  /** The provider a waiting turn needs a new sign-in to. */
  refused?: string
}

const same = (a: ModelChoice, b: ModelChoice) => a.provider === b.provider && a.modelId === b.modelId

/** Shows what setup checked and saved. Each fix opens its setup step. */
export default function Settings({ section, onSection, models, onSaved, onFix, onClose, onError, error, signIn, signIns, refused }: Props) {
  const [found, setFound] = useState<Found>({})
  const [saved, setSaved] = useState<Saved | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const take = <T,>(answer: Promise<T>, put: (value: T) => void, current: () => boolean, failed?: () => void) =>
    void answer.then(
      (value) => current() && put(value),
      (err: unknown) => {
        if (!current()) return
        failed?.()
        onError(String(err))
      },
    )
  const fill = <K extends keyof Found>(part: K, answer: Promise<Exclude<Found[K], 'failed' | undefined>>, current: () => boolean) =>
    take(
      answer,
      (value) => setFound((now) => ({ ...now, [part]: value })),
      current,
      () => setFound((now) => ({ ...now, [part]: 'failed' })),
    )

  useEffect(() => {
    let current = true
    fill('toolchain', sidecar('setup.tools', {}), () => current)
    fill('slicer', checkSlicer(), () => current)
    take(sidecar('state.get', {}), ({ settings }) => setSaved(settings), () => current)
    take(projectsFolder(), setFolder, () => current)
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    let current = true
    fill('logins', sidecar('auth.status', {}), () => current)
    return () => {
      current = false
    }
  }, [signIns])

  const save = (change: Methods['settings.set']['params']) => {
    setSaving(true)
    void sidecar('settings.set', change)
      .then((state) => {
        setSaved(state.settings)
        onSaved(state)
      })
      .catch((err: unknown) => onError(String(err)))
      .finally(() => setSaving(false))
  }

  const shown = forgetRefused(found, refused)
  const astra = Array.isArray(shown.logins) && astraSignedIn(shown.logins)

  const rows = (title: string, list: Row[]) => (
    <section className="setup-group" aria-label={title}>
      <h2>{title}</h2>
      <ul>
        {list.map((row) => (
          <li key={row.id} className="setup-row" data-status={row.status} data-testid={`settings-${row.id}`}>
            <span className="setup-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: row.icon }} />
            <span className="setup-what">
              <span className="setup-name">{row.name}</span>
              <span className="setup-detail">{row.detail}</span>
            </span>
            <span className="setup-act">
              {row.status !== 'ready' && row.status !== 'checking' && (
                <button type="button" onClick={() => onFix('check')}>
                  Fix in setup
                </button>
              )}
            </span>
            <span className="setup-status">{row.label}</span>
          </li>
        ))}
      </ul>
    </section>
  )

  const body = () => {
    switch (section) {
      case 'agents':
        return (
          <>
            {rows('Sign-ins', agentRows(shown.logins, refused))}
            <fieldset className="settings-models" disabled={saving}>
              <legend>Default model</legend>
              {models.length === 0 && <p className="setup-detail">Sign in to pick a model.</p>}
              {models.map((model) => (
                <label key={`${model.provider}/${model.modelId}`} className="settings-option">
                  <input
                    type="radio"
                    name="settings-model"
                    checked={saved !== null && same(model, saved.model)}
                    onChange={() => save({ model: { provider: model.provider, modelId: model.modelId } })}
                  />
                  <Mark modelId={model.modelId} />
                  <span className="setup-what">
                    <span className="setup-name">{model.name}</span>
                    <span className="setup-detail">{model.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="setup-switch">
              <input
                id="settings-astra"
                type="checkbox"
                role="switch"
                checked={astra && (saved?.astra ?? false)}
                disabled={!astra || saved === null || saving}
                aria-describedby={astra ? undefined : 'settings-astra-needs'}
                onChange={(event) => save({ astra: event.target.checked })}
              />
              <label htmlFor="settings-astra">Let the main agent ask GPT (Astra) for drawings</label>
              {!astra && (
                <span id="settings-astra-needs" className="setup-detail">
                  Needs a ChatGPT sign-in.
                </span>
              )}
            </div>
          </>
        )
      case 'slicer':
        return (
          <>
            {rows('Slicer', [slicerRow(found.slicer)])}
            <section className="setup-group" aria-label="Printer">
              <h2>Printer</h2>
              <ul>
                <li className="setup-row" data-testid="settings-printer">
                  <span />
                  <span className="setup-what">
                    <span className="setup-name">{saved?.printer.machine ?? 'Checking…'}</span>
                    {saved !== null && (
                      <span className="setup-detail">{[saved.printer.filament, saved.printer.process, saved.printer.plate].filter((part) => part !== undefined).join(', ')}</span>
                    )}
                  </span>
                  <span className="setup-act">
                    <button type="button" onClick={() => onFix('printer')}>
                      Change
                    </button>
                  </span>
                </li>
              </ul>
            </section>
          </>
        )
      case 'tools':
        return rows('uv and Python', buildRows(found.toolchain))
      case 'folder':
        return (
          <div className="settings-folder">
            <code>{folder ?? 'Checking…'}</code>
            {folder !== null && (
              <button type="button" onClick={() => void revealItemInDir(folder).catch((err: unknown) => onError(String(err)))}>
                Reveal
              </button>
            )}
          </div>
        )
    }
  }

  return (
    <div className="settings" data-testid="settings">
      <nav className="sessions" aria-label="Settings">
        {ORDER.map((id) => (
          <button key={id} type="button" className="row-open" aria-current={id === section ? 'page' : undefined} onClick={() => onSection(id)}>
            {SECTIONS[id].name}
          </button>
        ))}
      </nav>
      <main className="settings-main">
        {error}
        {signIn}
        <div className="settings-close">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <section className="settings-section" aria-label={SECTIONS[section].name}>
          <h1>{SECTIONS[section].name}</h1>
          <p>{SECTIONS[section].about}</p>
          {body()}
        </section>
      </main>
    </div>
  )
}
