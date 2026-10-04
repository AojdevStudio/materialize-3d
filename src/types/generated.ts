// Generated from the Rust types by ts-rs. Do not edit; regenerate with
// `cd src-tauri && UPDATE_GENERATED_TYPES=1 cargo test --lib generated_frontend_types`.

export type Actor = "human" | "agent" | "external_mcp";

export type BuildStep = "spec_validated" | "geometry_built" | "package_written" | "sliced" | "verified";

export type BuildStatus = "building" | "verified" | "failed" | "invalid";

export type ApprovalStatus = "pending" | "approved" | "void";

export type PrintStatus = "not_tested" | "passed" | "failed";

export type Stage = "generate" | "inspect" | "geometry" | "slice" | "handoff";

export type View = "face" | "isometric" | "front" | "top";

export type DesignSummary = { revision_id: string, lineage_id: string, kind: string, number: number, title: string, build: BuildStatus, failure_reason: string | null,
/**
 * Where a failed build stopped, when it stopped in a stage the spec's
 * author can repair: generate, inspect, geometry, slice, or handoff.
 */
stage: Stage | null,
/**
 * Blocking checks only; a failed advisory check is a warning.
 */
checks_passed: number, checks_total: number, failed_checks: Array<string>,
/**
 * Failed advisory checks, which a person acknowledges when approving.
 */
warnings: Array<string>,
/**
 * The person's measurements as the build measured them, for example
 * `width 60.02 mm (60 ± 0.2)`.
 */
requirements: Array<string>,
/**
 * The model's extent along x, y, and z in millimeters, when its build
 * recorded one.
 */
size_mm: [number, number, number] | null, package_sha256: string | null, approval: ApprovalStatus, print_validation: PrintStatus, requested_by: Actor, created_at: string, };

export type BuildResult = {
/**
 * True when nothing was built: the revision already existed, or it uses
 * an identical build that was already verified.
 */
reused: boolean,
/**
 * True when the revision was opened in the app for the person, as the
 * in-app agent's builds are.
 */
shown: boolean,
/**
 * The views sent with this result, in order.
 */
views: Array<View>,
/**
 * Each view the kind renders that this result could not carry, and why,
 * for example `front: not found`.
 */
views_missing: Array<string>, revision_id: string, lineage_id: string, kind: string, number: number, title: string, build: BuildStatus, failure_reason: string | null,
/**
 * Where a failed build stopped, when it stopped in a stage the spec's
 * author can repair: generate, inspect, geometry, slice, or handoff.
 */
stage: Stage | null,
/**
 * Blocking checks only; a failed advisory check is a warning.
 */
checks_passed: number, checks_total: number, failed_checks: Array<string>,
/**
 * Failed advisory checks, which a person acknowledges when approving.
 */
warnings: Array<string>,
/**
 * The person's measurements as the build measured them, for example
 * `width 60.02 mm (60 ± 0.2)`.
 */
requirements: Array<string>,
/**
 * The model's extent along x, y, and z in millimeters, when its build
 * recorded one.
 */
size_mm: [number, number, number] | null, package_sha256: string | null, approval: ApprovalStatus, print_validation: PrintStatus, requested_by: Actor, created_at: string, };
