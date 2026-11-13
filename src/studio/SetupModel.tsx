import { useEffect, useState } from 'react'
import type { ModelChoice, ModelOption } from '../../sidecar/src/protocol'
import { sidecar } from './api'
import { Mark } from './ModelPicker'
import type { StepProps } from './Setup'
import { AGENTS } from './SetupCheck'

/** The models of the signed-in agents, and whether the person may turn Astra on, which needs ChatGPT. */
type Offer = { models: ModelOption[]; chatgpt: boolean }

const same = (a: ModelChoice, b: ModelChoice) => a.provider === b.provider && a.modelId === b.modelId

/**
 * Setup's pick of the default model new projects take, and whether the main agent may ask Astra for drawings. Continue
 * saves both as shown, so a person without ChatGPT saves Astra off.
 */
export default function SetupModel({ next, back, onError }: StepProps) {
  const [offer, setOffer] = useState<Offer>({ models: [], chatgpt: false })
  const [picked, setPicked] = useState<ModelChoice | null>(null)
  const [astra, setAstra] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    void Promise.all([sidecar('models.list', {}), sidecar('auth.status', {}), sidecar('state.get', {})]).then(
      ([listed, logins, { settings }]) => {
        if (!current) return
        const models = listed.filter((model) => AGENTS.some((agent) => agent.provider === model.provider))
        const chatgpt = logins.some((login) => login.provider === 'openai-codex' && login.login !== null)
        const first = models.find((model) => same(model, settings.model)) ?? models[0]
        setOffer({ models, chatgpt })
        setPicked(first === undefined ? null : { provider: first.provider, modelId: first.modelId })
        setAstra(settings.astra && chatgpt)
      },
      (err: unknown) => current && onError(String(err)),
    )
    return () => {
      current = false
    }
  }, [])

  const save = () => {
    if (picked === null) return
    setSaving(true)
    void sidecar('settings.set', { model: picked, astra })
      .then(next, (err: unknown) => onError(String(err)))
      .finally(() => setSaving(false))
  }

  return (
    <>
      <h1>Pick your default model</h1>
      <p>New chats start with this model. You can switch any chat from the model button by the send box.</p>
      {AGENTS.map(({ id, provider, name }) => {
        const models = offer.models.filter((model) => model.provider === provider)
        return (
          models.length > 0 && (
            <fieldset key={id} className="setup-group">
              <legend>{name}</legend>
              {models.map((model) => (
                <label key={model.modelId} className="setup-model">
                  <input
                    type="radio"
                    name="setup-model"
                    checked={picked !== null && same(model, picked)}
                    onChange={() => setPicked({ provider: model.provider, modelId: model.modelId })}
                  />
                  <Mark modelId={model.modelId} />
                  <span className="setup-what">
                    <span className="setup-name">{model.name}</span>
                    <span className="setup-detail">{model.description}</span>
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
          disabled={!offer.chatgpt}
          aria-describedby={offer.chatgpt ? undefined : 'setup-astra-needs'}
          onChange={(event) => setAstra(event.target.checked)}
        />
        <label htmlFor="setup-astra">Let the main agent ask GPT (Astra) for drawings</label>
        {!offer.chatgpt && (
          <span id="setup-astra-needs" className="setup-detail">
            Needs a ChatGPT sign-in.
          </span>
        )}
      </div>
      <div className="setup-actions">
        <button type="button" onClick={back}>
          Back
        </button>
        <button type="button" className="primary" disabled={picked === null || saving} onClick={save}>
          Continue
        </button>
      </div>
    </>
  )
}
