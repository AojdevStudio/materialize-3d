import { useEffect, useState } from 'react'
import type { ModelChoice, ModelOption, Settings } from '../../sidecar/src/protocol'
import { sidecar } from './api'
import { Mark } from './ModelPicker'
import type { StepProps } from './Setup'
import { AGENTS } from './SetupCheck'

type Offer = { models: ModelOption[]; chatgptSignedIn: boolean; saved: Settings }

const same = (a: ModelChoice, b: ModelChoice) => a.provider === b.provider && a.modelId === b.modelId

/**
 * Setup's pick of the default model new projects take, and whether the main agent may ask Astra for drawings. Continue
 * saves both as shown, so a person without ChatGPT saves Astra off. A sign-in that ends here offers its models at once,
 * and the person's own picks stay.
 */
export default function SetupModel({ next, back, onError, signIn, signIns }: StepProps) {
  const [offer, setOffer] = useState<Offer | null>(null)
  const [picked, setPicked] = useState<ModelChoice | null>(null)
  const [astraPicked, setAstraPicked] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    void Promise.all([sidecar('models.list', {}), sidecar('auth.status', {}), sidecar('state.get', {})]).then(
      ([listed, logins, { settings }]) =>
        current &&
        setOffer({
          models: listed.filter((model) => AGENTS.some((agent) => agent.provider === model.provider)),
          chatgptSignedIn: logins.some((login) => login.provider === 'openai-codex' && login.login !== null),
          saved: settings,
        }),
      (err: unknown) => current && onError(String(err)),
    )
    return () => {
      current = false
    }
  }, [signIns])

  const models = offer?.models ?? []
  const offered = (wanted: ModelChoice | null | undefined) => wanted && models.find((row) => same(row, wanted))
  const model = offered(picked) ?? offered(offer?.saved.model) ?? models[0]
  const chatgptSignedIn = offer?.chatgptSignedIn ?? false
  const astra = chatgptSignedIn && (astraPicked ?? offer?.saved.astra ?? false)

  const save = () => {
    if (model === undefined) return
    setSaving(true)
    void sidecar('settings.set', { model: { provider: model.provider, modelId: model.modelId }, astra })
      .then(next, (err: unknown) => onError(String(err)))
      .finally(() => setSaving(false))
  }

  const goBack = () => {
    setSaving(true)
    void back().finally(() => setSaving(false))
  }

  return (
    <>
      <h1>Pick your default model</h1>
      <p>New chats start with this model. You can switch any chat from the model button by the send box.</p>
      {AGENTS.map(({ id, provider, name }) => {
        const rows = models.filter((row) => row.provider === provider)
        return (
          rows.length > 0 && (
            <fieldset key={id} className="setup-group" disabled={saving}>
              <legend>{name}</legend>
              {rows.map((row) => (
                <label key={row.modelId} className="setup-model">
                  <input
                    type="radio"
                    name="setup-model"
                    checked={model !== undefined && same(row, model)}
                    onChange={() => setPicked({ provider: row.provider, modelId: row.modelId })}
                  />
                  <Mark modelId={row.modelId} />
                  <span className="setup-what">
                    <span className="setup-name">{row.name}</span>
                    <span className="setup-detail">{row.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )
        )
      })}
      <div className="setup-switch">
        <input
          id="setup-astra"
          type="checkbox"
          role="switch"
          checked={astra}
          disabled={!chatgptSignedIn || saving}
          aria-describedby={chatgptSignedIn ? undefined : 'setup-astra-needs'}
          onChange={(event) => setAstraPicked(event.target.checked)}
        />
        <label htmlFor="setup-astra">Let the main agent ask GPT (Astra) for drawings</label>
        {!chatgptSignedIn && (
          <span id="setup-astra-needs" className="setup-detail">
            Needs a ChatGPT sign-in.
          </span>
        )}
      </div>
      {signIn}
      <div className="setup-actions">
        <button type="button" disabled={saving} onClick={goBack}>
          Back
        </button>
        <button type="button" className="primary" disabled={model === undefined || saving} onClick={save}>
          Continue
        </button>
      </div>
    </>
  )
}
