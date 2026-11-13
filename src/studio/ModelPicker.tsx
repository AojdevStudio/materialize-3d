import { useEffect, useRef, useState } from 'react'
import { modelName } from '../../sidecar/src/offered'
import type { ModelChoice, ModelOption } from '../../sidecar/src/protocol'
import claude from '../assets/icons/claude.svg?raw'
import openai from '../assets/icons/openai.svg?raw'

/** The maker's official mark for a model, by its id: the Claude mark for Anthropic's models, the OpenAI mark for GPT models. */
function markOf(modelId: string): string | undefined {
  if (modelId.startsWith('claude-')) return claude
  if (modelId.startsWith('gpt-')) return openai
  return undefined
}

/** A model's mark. A model with none keeps the space, so the names line up. */
function Mark({ modelId }: { modelId: string }) {
  const svg = markOf(modelId)
  return <span className="model-mark" aria-hidden="true" dangerouslySetInnerHTML={svg === undefined ? undefined : { __html: svg }} />
}

type Props = {
  models: ModelOption[]
  /** The model the next turn runs on. Null until the saved state is read. */
  chosen: ModelChoice | null
  onPick: (model: ModelChoice) => void
}

/** The model picker: the chosen model's mark and short name, and the short list of the signed-in providers' models with a check on it. */
export default function ModelPicker({ models, chosen, onPick }: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const isChosen = (model: ModelChoice) => model.provider === chosen?.provider && model.modelId === chosen.modelId

  // The open menu closes on a click outside it, or on Escape.
  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

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
