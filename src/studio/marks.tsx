import type { ReactNode } from 'react'
import mark from '../assets/brand/mark-small-32.svg'
import claude from '../assets/icons/claude.svg?raw'
import openai from '../assets/icons/openai.svg?raw'

/** An outline icon from `src/assets/icons`, drawn in the text color. */
export const Icon = ({ svg, className }: { svg: string; className: string }) => (
  <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
)

/** The working mark: a still ring, since a spinning one repaints without end. */
export const WorkingRing = ({ className, size }: { className: string; size?: number }) => (
  <svg className={className} viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
    <circle cx={8} cy={8} r={6} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
    <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
  </svg>
)

/** The maker's official mark for a model, by its id: the Claude mark for Anthropic's models, the OpenAI mark for GPT models. */
function markOf(modelId: string): string | undefined {
  if (modelId.startsWith('claude-')) return claude
  if (modelId.startsWith('gpt-')) return openai
  return undefined
}

/** A model's mark. A model with none keeps the space, so the names line up. */
export function Mark({ modelId }: { modelId: string }) {
  const svg = markOf(modelId)
  return <span className="model-mark" aria-hidden="true" dangerouslySetInnerHTML={svg === undefined ? undefined : { __html: svg }} />
}

/** The top row of a sidebar: the Materialize 3D mark and name, with any controls at its end. */
export function BrandRow({ children }: { children?: ReactNode }) {
  return (
    <div className="side-header">
      <div className="brand" data-testid="brand">
        <img src={mark} alt="" width={20} height={20} />
        Materialize 3D
      </div>
      {children}
    </div>
  )
}
