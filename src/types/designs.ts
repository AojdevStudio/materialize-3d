// TypeScript mirror of the revision types the Rust backend serializes.
// Source of truth: src-tauri/src/fabrication/revisions.rs (Revision and its
// three axes), src-tauri/src/fabrication/pipeline.rs (BuildOutcome), and
// src-tauri/src/fabrication/bambu/slice.rs (EffectiveSettings). Field names follow
// the serde attributes there: snake_case fields, `status`-tagged enums.
// `Actor` and `BuildStep` are generated from Rust (./generated.ts).

import type { Actor, BuildStep } from './generated'

export type { Actor, BuildStep }

/** UUID of one revision (`RevisionId`, serde transparent). */
export type RevisionId = string
/** UUID shared by every revision of one design (`LineageId`, serde transparent). */
export type LineageId = string
/** Id of one build, shared by every revision whose spec builds the same way (`BuildId`). */
export type BuildId = string
/** Lowercase 64-char hex SHA-256 (`Sha256Hex`). */
export type Sha256Hex = string

export interface SlicerIdentity {
  name: string
  version: string
  profile_version: string
}

/**
 * `id` is namespaced: `geometry.<check>.<subject>`, `print.<check>.<body>`, `slice.<check>`, or
 * `handoff.<check>`. A failed advisory check is a warning, not a failure.
 */
export interface RecordedCheck {
  id: string
  passed: boolean
  advisory: boolean
  detail: string
}

/** The settings Bambu Studio actually sliced with (`--export-settings`). */
export interface EffectiveSettings {
  printer_settings_id: string
  print_settings_id: string
  filament_settings_id: string[]
  filament_colour: string[]
  nozzle_diameter: string[]
  printable_area: string[]
  layer_height: string
  enable_prime_tower: boolean
  start_gcode_matches_preset: boolean
  start_gcode_in_gcode_header: boolean
}

export interface Artifacts {
  revision_dir: string
  package_path: string
  package_sha256: Sha256Hex
  preview_path: string
  slice_dir: string
  gcode_sha256: Sha256Hex
  slicer: SlicerIdentity
  /** `null` when Bambu Studio exported no effective settings. */
  effective_settings: EffectiveSettings | null
  checks: RecordedCheck[]
}

export type BuildState =
  | { status: 'building' }
  | { status: 'verified'; artifacts: Artifacts }
  | { status: 'failed'; reason: string; artifacts: Artifacts | null }
  /** Was verified, but its package changed or went missing on disk. */
  | { status: 'invalid'; reason: string; artifacts: Artifacts }

export type Approval =
  | { status: 'pending' }
  | { status: 'approved'; package_sha256: Sha256Hex; acknowledged_warnings: string[]; at: string }
  | { status: 'void'; reason: string; at: string }

export type PrintValidation =
  | { status: 'not_tested' }
  | { status: 'passed'; at: string; note: string }
  | { status: 'failed'; at: string; note: string }

export interface SignInk {
  name: string
  /** `#RRGGBB` */
  hex: string
}

/** The spec exactly as submitted (validated by the backend before it was stored). */
export interface SignSpec {
  schema_version: number
  title?: string | null
  width_mm: number
  height_mm: number
  thickness_mm?: number
  inlay_depth_mm?: number
  corner_radius_mm?: number | null
  /** Filament slot 1. */
  base: SignInk
  /** Filament slots 2 and 3. */
  inks: SignInk[]
  elements: unknown[]
}

interface RevisionBase {
  id: RevisionId
  lineage_id: LineageId
  number: number
  parent_id: RevisionId | null
  title: string
  spec_sha256: Sha256Hex
  build_id: BuildId
  build_key: Sha256Hex
  requested_by: Actor
  build: BuildState
  approval: Approval
  print_validation: PrintValidation
  created_at: string
  updated_at: string
}

/**
 * A part's spec as submitted: model-written build123d with its params,
 * requirements, and filaments. The part view that reads it is unit pr8-gui's.
 */
export interface PartSpec {
  schema_version: number
  title: string
  source: string
  params: Record<string, number | boolean | string>
  requirements: unknown[]
  filaments: unknown[]
}

export type SignRevision = RevisionBase & { kind: 'sign'; spec: SignSpec }
export type PartRevision = RevisionBase & { kind: 'part'; spec: PartSpec }

/** One revision of a design. `kind` decides the shape of `spec`; each new kind adds a member. */
export type Revision = SignRevision | PartRevision

/** The registered kinds. */
export type Kind = Revision['kind']

export interface BuildOutcome {
  revision: Revision
  /** True when nothing ran: the revision already existed, or it uses an identical verified build. */
  reused: boolean
}

/** Payload of the `designs:open` event: the agent asks the UI to show one revision. */
export interface DesignsOpenPayload {
  revisionId: RevisionId
}

/** Artifacts of any revision that produced them, including a failed-with-evidence build. */
export function revisionArtifacts(revision: Revision): Artifacts | null {
  switch (revision.build.status) {
    case 'verified':
    case 'invalid':
      return revision.build.artifacts
    case 'failed':
      return revision.build.artifacts
    case 'building':
      return null
  }
}

/** The warnings a build recorded (its failed advisory checks), which approving acknowledges. */
export function buildWarnings(artifacts: Artifacts): string[] {
  return artifacts.checks.filter((check) => check.advisory && !check.passed).map((check) => check.id)
}
