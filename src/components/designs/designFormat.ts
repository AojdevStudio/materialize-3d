// Pure presentation helpers for the designs view. Nothing here merges the three
// revision axes (build, approval, print validation); each is summarized alone.

import type { Approval, BuildState, PrintValidation, RecordedCheck, Revision, Sha256Hex } from '../../types/designs'

/** `abc123f…c4e7`: the first 7 and last 4 hex digits, the form the Approve button shows. */
export function shortHash(hash: Sha256Hex): string {
  return `${hash.slice(0, 7)}…${hash.slice(-4)}`
}

export type Tone = 'ok' | 'bad' | 'muted'

export interface StateWord {
  text: string
  tone: Tone
}

export function buildWord(build: BuildState): StateWord {
  switch (build.status) {
    case 'building':
      return { text: 'Building', tone: 'muted' }
    case 'verified':
      return { text: 'Verified', tone: 'ok' }
    case 'failed':
      return { text: 'Failed', tone: 'bad' }
    case 'invalid':
      return { text: 'Invalid', tone: 'bad' }
  }
}

export function approvalWord(approval: Approval): StateWord {
  switch (approval.status) {
    case 'pending':
      return { text: 'Pending', tone: 'muted' }
    case 'approved':
      return { text: 'Approved', tone: 'ok' }
    case 'void':
      return { text: 'Void', tone: 'bad' }
  }
}

export function printWord(print: PrintValidation): StateWord {
  switch (print.status) {
    case 'not_tested':
      return { text: 'Not tested', tone: 'muted' }
    case 'passed':
      return { text: 'Passed', tone: 'ok' }
    case 'failed':
      return { text: 'Failed', tone: 'bad' }
  }
}

/** Local `YYYY-MM-DD HH:MM`, or the raw value when it is not a date. */
export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `start_gcode_intact` -> `Start G-code intact`. */
export function checkLabel(name: string): string {
  const words = name.replace(/_/g, ' ').replace(/\bgcode\b/gi, 'G-code')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const STAGES = { geometry: 'Geometry', print: 'Print', slice: 'Slice', handoff: 'Handoff' } as const
type StageKey = keyof typeof STAGES

interface ParsedCheck {
  stage: string
  name: string
  /** Body name for `geometry.<name>.<subject>`; empty otherwise. */
  subject: string
}

function parseCheckId(id: string): ParsedCheck {
  const [stageKey = '', name = id, ...subject] = id.split('.')
  const stage = stageKey in STAGES ? STAGES[stageKey as StageKey] : stageKey
  return { stage, name, subject: subject.join('.') }
}

export interface CheckRow {
  key: string
  stage: string
  label: string
  passed: boolean
  /** A failed advisory check: shown, and acknowledged on approval, but not a failure. */
  warning: boolean
  detail: string
  /** Per-subject details of a grouped geometry row. */
  title?: string
}

/**
 * Table rows for a revision's checks: every failed check first with its own
 * detail, then every warning, then passing geometry checks grouped by name
 * (one row lists the bodies it covered), then each other passing check on its
 * own row.
 */
export function checkRows(checks: RecordedCheck[]): CheckRow[] {
  const single = (check: RecordedCheck): CheckRow => {
    const { stage, name, subject } = parseCheckId(check.id)
    return {
      key: check.id,
      stage,
      label: subject ? `${checkLabel(name)} (${subject})` : checkLabel(name),
      passed: check.passed,
      warning: check.advisory && !check.passed,
      detail: check.detail,
    }
  }

  const failed = checks.filter((check) => !check.passed && !check.advisory).map(single)
  const warnings = checks.filter((check) => !check.passed && check.advisory).map(single)
  const geometry = new Map<string, RecordedCheck[]>()
  const others: CheckRow[] = []
  for (const check of checks.filter((check) => check.passed)) {
    const parsed = parseCheckId(check.id)
    if (parsed.stage === STAGES.geometry) {
      geometry.set(parsed.name, [...(geometry.get(parsed.name) ?? []), check])
    } else {
      others.push(single(check))
    }
  }

  const grouped = [...geometry].map(([name, group]): CheckRow => {
    const subjects = group.map((check) => parseCheckId(check.id).subject)
    const onlySign = group.length === 1 && subjects[0] === 'sign'
    return {
      key: `geometry.${name}`,
      stage: STAGES.geometry,
      label: checkLabel(name),
      passed: true,
      warning: false,
      detail: onlySign ? group[0].detail : subjects.join(', '),
      title: group.map((check, index) => `${subjects[index]}: ${check.detail}`).join('\n'),
    }
  })

  return [...failed, ...warnings, ...grouped, ...others]
}

/**
 * Why Approve is unavailable for a build that is not verified: the first
 * failing check with its detail, else the build's recorded reason.
 */
export function approveBlockedReason(revision: Revision): string | null {
  const { build } = revision
  switch (build.status) {
    case 'verified':
      return null
    case 'building':
      return 'Build still running'
    case 'invalid':
      return build.reason
    case 'failed': {
      const failed = build.artifacts?.checks.find((check) => !check.passed && !check.advisory)
      if (!failed) return build.reason
      const { name, subject } = parseCheckId(failed.id)
      const label = subject ? `${checkLabel(name)} (${subject})` : checkLabel(name)
      return `${label} failed: ${failed.detail}`
    }
  }
}

/** Default Save dialog name: `<title>-r<N>.3mf`, with path separators removed from the title. */
export function exportFileName(revision: Revision): string {
  const title = revision.title.replace(/[\\/:*?"<>|]/g, '-').trim() || revision.kind
  return `${title}-r${revision.number}.3mf`
}

/** One axis row of the detail: the state word and its supporting note. */
export interface AxisSummary {
  word: StateWord
  note: string
}

/** Blocking checks only; warnings are counted on their own. */
function checkCount(checks: RecordedCheck[]): string {
  const blocking = checks.filter((check) => !check.advisory)
  const warnings = checks.filter((check) => check.advisory && !check.passed).length
  const counted = `${blocking.filter((check) => check.passed).length} of ${blocking.length} checks passed`
  return warnings > 0 ? `${counted}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : counted
}

/** "Sliced and verified": the build axis alone. */
export function buildAxis(revision: Revision): AxisSummary {
  const { build } = revision
  switch (build.status) {
    case 'building':
      return { word: buildWord(build), note: `started ${formatTime(revision.created_at)}` }
    case 'verified':
      return {
        word: { text: 'Yes', tone: 'ok' },
        note: `${checkCount(build.artifacts.checks)}, ${formatTime(revision.updated_at)}`,
      }
    case 'failed':
      return {
        word: { text: 'No', tone: 'bad' },
        note: build.artifacts ? `sliced, ${checkCount(build.artifacts.checks)}` : build.reason,
      }
    case 'invalid':
      return { word: { text: 'No', tone: 'bad' }, note: build.reason }
  }
}

/** "Approval": the approval axis alone. A pending approval names the hash it would bind to, if any. */
export function approvalAxis(revision: Revision): AxisSummary {
  const { approval, build } = revision
  const word = approvalWord(approval)
  switch (approval.status) {
    case 'approved':
      return { word, note: `for ${shortHash(approval.package_sha256)}, ${formatTime(approval.at)}` }
    case 'void':
      return { word, note: `${approval.reason}, ${formatTime(approval.at)}` }
    case 'pending':
      return {
        word,
        note: build.status === 'verified' ? `for ${shortHash(build.artifacts.package_sha256)}` : 'no verified package to approve',
      }
  }
}

/** "Print-tested": the physical print axis alone. Only a person sets it. */
export function printAxis(revision: Revision): AxisSummary {
  const print = revision.print_validation
  const word = printWord(print)
  switch (print.status) {
    case 'not_tested':
      return { word, note: 'set only by a human' }
    case 'passed':
    case 'failed':
      return { word, note: [formatTime(print.at), print.note].filter(Boolean).join(', ') }
  }
}
