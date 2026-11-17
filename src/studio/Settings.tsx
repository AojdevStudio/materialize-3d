import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { type ReactNode, useEffect, useState } from 'react'
import type { Methods, Setup } from '../../sidecar/src/protocol'
import { astraSignedIn, sameModel } from './agents'
import { projectsFolder } from './api'
import { agentRows, buildRows, forgetRefused, type Row, slicerRow } from './checkRows'
import { BrandRow, Icon } from './marks'
import { AstraSwitch, CheckGroup, ModelRow, useFound } from './setupRows'
import { checkReady, saveSettings, useStudio } from './store'
import chat from '../assets/icons/message-square.svg?raw'
import layers from '../assets/icons/layers.svg?raw'
import blocks from '../assets/icons/module-three.svg?raw'
import terminal from '../assets/icons/terminal.svg?raw'

const ORDER = ['agents', 'slicer', 'tools', 'folder'] as const
export type Section = (typeof ORDER)[number]

const SECTIONS: Record<Section, { name: string; about: string; icon: string }> = {
  agents: { name: 'Agents and models', about: 'Who does the work, and the model new projects start with.', icon: chat },
  slicer: { name: 'Slicer and printer', about: 'What makes the print-ready 3MF, and the printer it slices for.', icon: layers },
  tools: { name: 'Build tools', about: 'What the agent builds and checks your parts with.', icon: terminal },
  folder: { name: 'Projects folder', about: 'Each project is a folder here, with its parts, guides, and print files.', icon: blocks },
}

type Props = {
  section: Section
  onSection: (section: Section) => void
  /** Opens the setup step that owns a fix. Settings shows again when it ends. */
  onFix: (step: Setup['step']) => void
  onClose: () => void
  onError: (message: string) => void
  error: ReactNode
  /** A sign-in question still open. Back in a setup step can leave one, so Settings shows it too. */
  signIn: ReactNode
  /** The provider a waiting turn needs a new sign-in to. */
  refused?: string
}

/** Shows what setup checked and saved. Each fix opens its setup step. */
export default function Settings({ section, onSection, onFix, onClose, onError, error, signIn, refused }: Props) {
  const found = useFound(onError)
  const models = useStudio((s) => s.models)
  const saved = useStudio((s) => s.settings)
  const [folder, setFolder] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    void projectsFolder().then(
      (value) => current && setFolder(value),
      (err: unknown) => current && onError(String(err)),
    )
    return () => {
      current = false
    }
  }, [])

  const save = (change: Methods['settings.set']['params']) => {
    setSaving(true)
    void saveSettings(change)
      .then(() => checkReady())
      .catch((err: unknown) => onError(String(err)))
      .finally(() => setSaving(false))
  }

  const shown = forgetRefused(found, refused)
  const astra = Array.isArray(shown.logins) && astraSignedIn(shown.logins)

  const rows = (title: string, list: Row[]) => (
    <CheckGroup
      title={title}
      rows={list}
      testId="settings"
      act={(row) =>
        row.status !== 'ready' &&
        row.status !== 'checking' && (
          <button type="button" onClick={() => onFix('check')}>
            Fix in setup
          </button>
        )
      }
    />
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
                <ModelRow
                  key={`${model.provider}/${model.modelId}`}
                  model={model}
                  className="settings-option"
                  name="settings-model"
                  checked={saved !== null && sameModel(model, saved.model)}
                  onPick={() => save({ model: { provider: model.provider, modelId: model.modelId } })}
                />
              ))}
            </fieldset>
            <AstraSwitch id="settings-astra" signedIn={astra} on={saved?.astra ?? false} busy={saved === null || saving} onChange={(on) => save({ astra: on })} />
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
        <BrandRow />
        {ORDER.map((id) => (
          <button key={id} type="button" className="row-open" aria-current={id === section ? 'page' : undefined} onClick={() => onSection(id)}>
            <Icon className="side-icon" svg={SECTIONS[id].icon} />
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
