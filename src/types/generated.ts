// Generated from the Rust types by ts-rs. Do not edit; regenerate with
// `cd src-tauri && UPDATE_GENERATED_TYPES=1 cargo test --lib generated_frontend_types`.

export type Actor = "human" | "agent" | "external_mcp";

export type BuildStep = "spec_validated" | "geometry_built" | "package_written" | "sliced" | "verified";

export type BuildStatus = "building" | "verified" | "failed" | "invalid";

export type ApprovalStatus = "pending" | "approved" | "void";

export type PrintStatus = "not_tested" | "passed" | "failed";

export type DesignSummary = { revision_id: string, lineage_id: string, kind: string, number: number, title: string, build: BuildStatus, failure_reason: string | null,
/**
 * Blocking checks only; a failed advisory check is a warning.
 */
checks_passed: number, checks_total: number, failed_checks: Array<string>,
/**
 * Failed advisory checks, which a person acknowledges when approving.
 */
warnings: Array<string>, package_sha256: string | null, approval: ApprovalStatus, print_validation: PrintStatus, requested_by: Actor, created_at: string, };

export type BuildResult = {
/**
 * True when nothing was built: the revision already existed, or it uses
 * an identical build that was already verified.
 */
reused: boolean, revision_id: string, lineage_id: string, kind: string, number: number, title: string, build: BuildStatus, failure_reason: string | null,
/**
 * Blocking checks only; a failed advisory check is a warning.
 */
checks_passed: number, checks_total: number, failed_checks: Array<string>,
/**
 * Failed advisory checks, which a person acknowledges when approving.
 */
warnings: Array<string>, package_sha256: string | null, approval: ApprovalStatus, print_validation: PrintStatus, requested_by: Actor, created_at: string, };
