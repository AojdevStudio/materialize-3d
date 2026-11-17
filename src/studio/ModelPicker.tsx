import { useRef, useState } from 'react'
import { modelName } from '../../sidecar/src/offered'
import type { ModelChoice, ModelOption } from '../../sidecar/src/protocol'
import { Mark } from './marks'
import { useDismiss } from './useDismiss'

type Props = {
  models: ModelOption[]
  /** The model the next turn runs on. Null until the saved state is read. */
  chosen: ModelChoice | null
  onPick: (model: ModelChoice) => void
}

/**
 * The model picker. The button shows the chosen model's mark and short name. The menu shows the short list for the
 * signed-in providers, with a check on the chosen model.
 */
export default function ModelPicker({ models, chosen, onPick }: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const isChosen = (model: ModelChoice) => model.provider === chosen?.provider && model.modelId === chosen.modelId

  useDismiss(open, box, () => setOpen(false))

  return (
    <div className="model-picker" ref={box}>
      {open && (
        <div className="model-menu" role="menu" aria-label="Models">
          {models.map(({ provider, modelId, name }) => (
            <button
              type="button"
              key={`${provider}/${modelId}`}
              role="menuitemradio"
              aria-checked={isChosen({ provider, modelId })}
              onClick={() => {
                setOpen(false)
                if (!isChosen({ provider, modelId })) onPick({ provider, modelId })
              }}
            >
              <Mark modelId={modelId} />
              <span className="model-name">{name}</span>
              {isChosen({ provider, modelId }) && (
                <svg className="model-check" viewBox="0 0 16 16" width={14} height={14} aria-hidden="true">
                  <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="model-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={chosen === null || models.length === 0}
        onClick={() => setOpen(!open)}
        data-testid="model-picker"
      >
        {chosen !== null && <Mark modelId={chosen.modelId} />}
        <span>{chosen === null ? 'Model' : modelName(chosen)}</span>
        <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  )
}
