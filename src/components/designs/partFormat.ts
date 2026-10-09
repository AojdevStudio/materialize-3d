// Pure presentation helpers for a part's detail. A part's spec reaches the UI
// as the JSON it was submitted with (`PartSpec.requirements` is `unknown[]`),
// so its requirements are parsed here, at the edge of the view.

import { approveBlockedReason } from './designFormat'
import type { RecordedCheck, Revision } from '../../types/designs'

type Axis = 'x' | 'y' | 'z'

/** One requirement as `src-tauri/src/fabrication/kinds/part/spec.rs` serializes it (`measure`-tagged). */
type Requirement =
  | { measure: 'span'; name: string; axis: Axis; mm: number; tol: number }
  | { measure: 'opening' | 'hole'; name: string; axis: Axis; mm: number; tol: number }
  | { measure: 'min_wall'; name: string; mm: number }

export interface RequirementRow {
  /** Position in the spec; its check is `geometry.requirement.<index>`. */
  index: number
  name: string
  /** `span x`, `opening z`, `hole x`, or `min wall`. */
  kind: string
  /** `22.00 ± 0.20` or `at least 3.00`, in mm. */
  target: string
  /** The measured mm as the check recorded it, or null when the build has no such check or the check could not measure. */
  measured: string | null
  /** Null while the build has not recorded this requirement's check. */
  passed: boolean | null
  /** The check's own words, which name why a requirement could not be measured. */
  detail: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isAxis = (value: unknown): value is Axis => value === 'x' || value === 'y' || value === 'z'
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function parseRequirement(value: unknown): Requirement | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !isNumber(value.mm)) return null
  const { measure, name, mm, axis, tol } = value
  switch (measure) {
    case 'span':
    case 'opening':
    case 'hole':
      return isAxis(axis) && isNumber(tol) ? { measure, name: name.trim(), axis, mm, tol } : null
    case 'min_wall':
      return { measure, name: name.trim(), mm }
    default:
      return null
  }
}

const mm = (value: number) => value.toFixed(2)

/** `Width 22.00 mm (22 ± 0.2)` -> `22.00`: the number the check measured, read after the requirement's name. */
function measuredValue(name: string, check: RecordedCheck): string | null {
  if (!check.detail.startsWith(`${name} `)) return null
  return /^(-?\d+(?:\.\d+)?) mm\b/.exec(check.detail.slice(name.length + 1))?.[1] ?? null
}

/**
 * One row per requirement in the spec, in spec order, each joined to its
 * recorded check. An entry the backend would never have accepted is skipped.
 */
export function requirementRows(requirements: unknown, checks: RecordedCheck[]): RequirementRow[] {
  if (!Array.isArray(requirements)) return []
  return requirements.flatMap((value, index): RequirementRow[] => {
    const requirement = parseRequirement(value)
    if (!requirement) return []
    const check = checks.find((recorded) => recorded.id === `geometry.requirement.${index}`)
    const kind = requirement.measure === 'min_wall' ? 'min wall' : `${requirement.measure} ${requirement.axis}`
    const target = requirement.measure === 'min_wall' ? `at least ${mm(requirement.mm)}` : `${mm(requirement.mm)} ± ${mm(requirement.tol)}`
    return [
      {
        index,
        name: requirement.name,
        kind,
        target,
        measured: check ? measuredValue(requirement.name, check) : null,
        passed: check ? check.passed : null,
        detail: check?.detail ?? '',
      },
    ]
  })
}

/**
 * Why a part revision cannot be approved, or null when it can. A failed
 * requirement reads as its own measurement (`Desk opening 17.40 mm (18 ± 0.3)`),
 * since its check id names only an index; anything else reads as for a sign.
 */
export function partBlockedReason(revision: Revision): string | null {
  const { build } = revision
  if (build.status === 'failed') {
    const failed = build.artifacts?.checks.find((check) => !check.passed && !check.advisory)
    if (failed?.id.startsWith('geometry.requirement.')) return failed.detail
  }
  return approveBlockedReason(revision)
}
