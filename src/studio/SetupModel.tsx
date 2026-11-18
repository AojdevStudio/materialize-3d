import { useLayoutEffect, useState } from 'react'
import type { ModelChoice } from '../../sidecar/src/protocol'
import { AGENTS, astraSignedIn, sameModel } from './agents'
import type { StepProps } from './Setup'
import { AstraSwitch, ModelRow } from './setupRows'
import { loadModels, readLogins, saveSettings, useStudio } from './store'

/**
 * Setup's pick of the default model new projects take, and whether the main agent may ask Astra for drawings. Continue
 * saves both as shown, so a person without ChatGPT saves Astra off. A sign-in that ends here offers its models at once,
 * and the person's own picks stay.
 */
export default function SetupModel({ next, back, onError, signIn }: StepProps) {
  const listed = useStudio((s) => s.models)
  const logins = useStudio((s) => s.logins)
  const saved = useStudio((s) => s.settings)
  const [picked, setPicked] = useState<ModelChoice | null>(null)
  const [astraPicked, setAstraPicked] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  // Before the screen paints, so it offers nothing until it knows the sign-ins as they are now. The models are read
  // first, so they answer before the sign-ins that show them.
  useLayoutEffect(() => {
    loadModels()
    readLogins(true)
  }, [])

  const known = Array.isArray(logins) && saved !== null
  const models = known ? listed.filter((model) => AGENTS.some((agent) => agent.provider === model.provider)) : []
  const offered = (wanted: ModelChoice | null | undefined) => wanted && models.find((row) => sameModel(row, wanted))
  const model = offered(picked) ?? offered(saved?.model) ?? models[0]
  const chatgptSignedIn = known && astraSignedIn(logins)
  const astra = chatgptSignedIn && (astraPicked ?? saved?.astra ?? false)

  const save = () => {
    if (model === undefined) return
    setSaving(true)
    void saveSettings({ model: { provider: model.provider, modelId: model.modelId }, astra })
      .then(() => next(), (err: unknown) => onError(String(err)))
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
                <ModelRow
                  key={row.modelId}
                  model={row}
                  className="setup-model"
                  name="setup-model"
                  checked={model !== undefined && sameModel(row, model)}
                  onPick={() => setPicked({ provider: row.provider, modelId: row.modelId })}
                />
              ))}
            </fieldset>
          )
        )
      })}
      <AstraSwitch id="setup-astra" signedIn={chatgptSignedIn} on={astra} busy={saving} onChange={setAstraPicked} />
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
