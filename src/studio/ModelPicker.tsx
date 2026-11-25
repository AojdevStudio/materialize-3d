import { useRef, useState } from 'react'
import { modelName } from '../../sidecar/src/offered'
import type { ModelChoice, ModelOption } from '../../sidecar/src/protocol'
import { sameModel } from './agents'
import { Mark } from './marks'
import { useDismiss } from './useDismiss'

/**
 * The lead's picker offers a model only. Its `chosen` is null until the saved state is read. The helper's picker also
 * offers "No helper" on top, and its null `chosen` is that choice.
 */
type Role =
  | { role: 'Lead'; chosen: ModelChoice | null; onPick: (model: ModelChoice) => void }
  | { role: 'Helper'; chosen: ModelChoice | null; onPick: (model: ModelChoice | null) => void }

/** `held` keeps the button off while a send is on its way, so a pick never overlaps it. */
type Props = Role & { models: ModelOption[]; held?: boolean }

const Check = () => (
  <svg className="model-check" viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** A role's model, with the role's word before it. The menu offers the short list for the signed-in providers. */
export default function ModelPicker(props: Props) {
  const { models, chosen, role, held = false } = props
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const helper = props.role === 'Helper'
  const isChosen = (model: ModelChoice) => chosen !== null && sameModel(model, chosen)
  // The chosen model picks again too: that is how a chat chooses again a model it found retired.
  const pick = (model: ModelChoice | null) => {
    setOpen(false)
    if (props.role === 'Helper') props.onPick(model)
    else if (model !== null) props.onPick(model)
  }

  useDismiss(open, box, () => setOpen(false))
  const shownName = chosen === null ? (helper ? 'None' : 'Model') : modelName(chosen)

  return (
    <div className={`model-picker${helper ? ' helper-picker' : ''}`} ref={box}>
      {open && (
        <div className="model-menu" role="menu" aria-label={`${role} models`}>
          {helper && (
            <button type="button" className="menu-none" role="menuitemradio" aria-checked={chosen === null} onClick={() => pick(null)}>
              <span className="model-mark" aria-hidden="true" />
              <span className="model-name">No helper</span>
              {chosen === null && <Check />}
            </button>
          )}
          {models.map(({ provider, modelId, name }) => (
            <button
              type="button"
              key={`${provider}/${modelId}`}
              role="menuitemradio"
              aria-checked={isChosen({ provider, modelId })}
              onClick={() => pick({ provider, modelId })}
            >
              <Mark modelId={modelId} />
              <span className="model-name">{name}</span>
              {isChosen({ provider, modelId }) && <Check />}
            </button>
          ))}
        </div>
      )}
      <span className="model-role">{role}</span>
      <button
        type="button"
        className={`model-button${chosen === null && helper ? ' model-none' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={held || (chosen === null && !helper) || models.length === 0}
        onClick={() => setOpen(!open)}
        data-testid={helper ? 'helper-picker' : 'model-picker'}
        // The role comes first in the name, so two pickers on the same model still read apart.
        aria-label={`${role}: ${shownName}`}
      >
        {chosen !== null && <Mark modelId={chosen.modelId} />}
        <span>{shownName}</span>
        <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}
