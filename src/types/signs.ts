// TypeScript mirror of the sign revision types the Rust backend serializes.
// Source of truth: src-tauri/src/fabrication/revisions.rs (SignRevision and its
// three axes), src-tauri/src/fabrication/build.rs (BuildStep, BuildOutcome), and
// src-tauri/src/fabrication/bambu/slice.rs (EffectiveSettings). Field names follow
// the serde attributes there: snake_case fields, `status`-tagged enums.

/** UUID of one revision (`RevisionId`, serde transparent). */
export type RevisionId = string
/** UUID shared by every revision of one sign (`LineageId`, serde transparent). */
export type LineageId = string
/** Lowercase 64-char hex SHA-256 (`Sha256Hex`). */
export type Sha256Hex = string

export type Actor = 'human' | 'agent' | 'external_mcp'

export interface SlicerIdentity {
  name: string
  version: string
  profile_version: string
}

/** `id` is namespaced: `geometry.<check>.<subject>`, `slice.<check>`, or `handoff.<check>`. */
export interface RecordedCheck {
  id: string
  passed: boolean
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

export type Approval =
  | { status: 'pending' }
  | { status: 'approved'; package_sha256: Sha256Hex; at: string }
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

export interface SignRevision {
  id: RevisionId
  lineage_id: LineageId
  number: number
  parent_id: RevisionId | null
  title: string
  spec: SignSpec
  spec_sha256: Sha256Hex
  build_key: Sha256Hex
  requested_by: Actor
  build: BuildState
  approval: Approval
  print_validation: PrintValidation
  created_at: string
  updated_at: string
}

/** Coarse build progress, sent over the `onProgress` channel once each step completes. */
export type BuildStep = 'spec_validated' | 'geometry_built' | 'package_written' | 'sliced' | 'verified'

export interface BuildOutcome {
  revision: SignRevision
  /** True when an identical build already existed and nothing ran. */
  reused: boolean
}

/** Payload of the `signs:open` event: the agent asks the UI to show one revision. */
export interface SignsOpenPayload {
  revisionId: RevisionId
}

/** Artifacts of any revision that produced them, including a failed-with-evidence build. */
export function revisionArtifacts(revision: SignRevision): Artifacts | null {
  switch (revision.build.status) {
    case 'verified':
      return revision.build.artifacts
    case 'failed':
      return revision.build.artifacts
    case 'building':
      return null
  }
}
