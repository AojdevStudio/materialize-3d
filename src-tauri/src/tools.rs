//! The one tool registry. Each tool a model can call is declared here once:
//! its name, description, argument schema, and what it does. The in-app Rig
//! agent (`agent::tools`) and the external MCP endpoint (`mcp`) both bind
//! from [`Tool::on`], so the two surfaces cannot drift apart.
//!
//! Tools reach the app only through [`RequestActions`], which has no way to
//! approve, export, or record a print result. Those stay with people.

use std::sync::{Arc, OnceLock};

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::actions::{ActionError, RequestActions, RequestActor};
use crate::fabrication::kind::{self, inlined_schema, BuildControl, KernelContext, KindDriver};
use crate::fabrication::printer::P2S_04;
use crate::fabrication::pipeline::BuildStep;
use crate::fabrication::revisions::{Actor, Approval, Artifacts, BuildState, PrintValidation, RecordedCheck, Revision};

/// Where a model meets the tools. The surface fixes the caller's
/// [`RequestActor`], so no argument can claim to be someone else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// The Rig agent in the app's chat panel.
    InAppAgent,
    /// External agents over the local MCP endpoint.
    ExternalMcp,
}

impl Surface {
    fn actor(self) -> RequestActor {
        match self {
            Surface::InAppAgent => RequestActor::Agent,
            Surface::ExternalMcp => RequestActor::ExternalMcp,
        }
    }
}

/// Every tool a model can call. There is deliberately no approve, export, or
/// print-result tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Build,
    Get,
    List,
    Show,
    PrinterStatus,
}

/// One call's context, supplied by the surface that received it.
pub struct ToolCall {
    pub surface: Surface,
    pub actions: Arc<dyn RequestActions>,
    /// Build progress for this call; the in-app agent forwards it to the UI.
    pub progress: Arc<dyn Fn(BuildStep) + Send + Sync>,
    /// Checked by long builds so a cancelled turn stops slicing.
    pub cancel: CancellationToken,
    /// Where the blocking action work runs. Cancelling drops a call's future
    /// but not its blocking thread, so an owner can wait on this tracker.
    pub blocking: TaskTracker,
}

impl ToolCall {
    /// Runs an action on the blocking pool so database, hashing, and slicing
    /// work never stalls an async task, and a panic stays inside this call.
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&dyn RequestActions) -> Result<T, ActionError> + Send + 'static,
    ) -> Result<T, ToolError> {
        let actions = self.actions.clone();
        Ok(self.blocking.spawn_blocking(move || work(actions.as_ref())).await??)
    }
}

/// Why a tool call failed. Surfaces hand the message back to the model.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid arguments: {0}")]
    InvalidArguments(serde_json::Error),
    #[error(transparent)]
    Action(#[from] ActionError),
    #[error("tool task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
    #[error("could not encode the result: {0}")]
    Output(serde_json::Error),
    #[error("the build tool does not offer kind {kind:?}; it offers {offered}")]
    KindNotOffered { kind: String, offered: String },
}

/// `build` arguments. `spec` goes to [`RequestActions::build`] unparsed so
/// the kind's own validation produces the error the model reads.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BuildArgs {
    /// What to build; each kind takes its own spec.
    kind: String,
    /// The complete spec for that kind.
    spec: Value,
    /// Build a new revision of this existing design (its `lineage_id`); omit for a new design.
    #[serde(default)]
    lineage_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListArgs {
    /// Most recent first; default 20, at most 100.
    #[serde(default)]
    #[schemars(range(min = 1, max = 100))]
    limit: Option<ListLimit>,
}

/// How many revisions `list` returns. Out of range is refused, never
/// clamped, so the caller learns its request was not honored.
#[derive(Deserialize, JsonSchema)]
#[serde(try_from = "u32")]
struct ListLimit(u32);

impl ListLimit {
    const DEFAULT: ListLimit = ListLimit(20);
}

impl TryFrom<u32> for ListLimit {
    type Error = String;

    fn try_from(limit: u32) -> Result<Self, Self::Error> {
        if (1..=100).contains(&limit) {
            Ok(ListLimit(limit))
        } else {
            Err(format!("limit must be from 1 to 100, got {limit}"))
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RevisionArgs {
    /// A design revision id (`revision_id` from build or list).
    revision_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

// The summary types below are what the chat reads; `tests::frontend_types`
// generates src/types/generated.ts from them.

/// A revision's build, as one word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum BuildStatus {
    Building,
    Verified,
    Failed,
    /// Verified once, but its package changed on disk.
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Void,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum PrintStatus {
    NotTested,
    Passed,
    Failed,
}

/// A compact view of a revision for models and the chat: enough to reason
/// about and to cite, without effective settings or file paths.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct DesignSummary {
    pub revision_id: String,
    pub lineage_id: String,
    pub kind: String,
    pub number: u32,
    pub title: String,
    pub build: BuildStatus,
    pub failure_reason: Option<String>,
    /// Blocking checks only; a failed advisory check is a warning.
    pub checks_passed: usize,
    pub checks_total: usize,
    pub failed_checks: Vec<String>,
    /// Failed advisory checks, which a person acknowledges when approving.
    pub warnings: Vec<String>,
    pub package_sha256: Option<String>,
    pub approval: ApprovalStatus,
    pub print_validation: PrintStatus,
    pub requested_by: Actor,
    pub created_at: String,
}

impl From<&Revision> for DesignSummary {
    fn from(revision: &Revision) -> Self {
        let artifacts = revision.artifacts();
        let checks = artifacts.map(Artifacts::checks).unwrap_or_default();
        let blocking = || checks.iter().filter(|c| !c.advisory);
        let described = |c: &RecordedCheck| format!("{}: {}", c.id, c.detail);
        Self {
            revision_id: revision.id.to_string(),
            lineage_id: revision.lineage_id.to_string(),
            kind: revision.kind.clone(),
            number: revision.number,
            title: revision.title.clone(),
            build: match revision.build {
                BuildState::Building => BuildStatus::Building,
                BuildState::Verified { .. } => BuildStatus::Verified,
                BuildState::Failed { .. } => BuildStatus::Failed,
                BuildState::Invalid { .. } => BuildStatus::Invalid,
            },
            failure_reason: match &revision.build {
                BuildState::Failed { reason, .. } | BuildState::Invalid { reason, .. } => Some(reason.clone()),
                BuildState::Building | BuildState::Verified { .. } => None,
            },
            checks_passed: blocking().filter(|c| c.passed).count(),
            checks_total: blocking().count(),
            failed_checks: blocking().filter(|c| !c.passed).map(described).collect(),
            warnings: checks.iter().filter(|c| c.advisory && !c.passed).map(described).collect(),
            package_sha256: artifacts.map(|a| a.files().package_sha256.to_string()),
            approval: match revision.approval {
                Approval::Pending => ApprovalStatus::Pending,
                Approval::Approved { .. } => ApprovalStatus::Approved,
                Approval::Void { .. } => ApprovalStatus::Void,
            },
            print_validation: match revision.print_validation {
                PrintValidation::NotTested => PrintStatus::NotTested,
                PrintValidation::Passed { .. } => PrintStatus::Passed,
                PrintValidation::Failed { .. } => PrintStatus::Failed,
            },
            requested_by: revision.requested_by,
            created_at: revision.created_at.clone(),
        }
    }
}

/// What `build` returns.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct BuildResult {
    #[serde(flatten)]
    pub revision: DesignSummary,
    /// True when nothing was built: the revision already existed, or it uses
    /// an identical build that was already verified.
    pub reused: bool,
}

/// What `show` returns.
#[derive(Debug, Clone, Serialize)]
pub struct Shown {
    pub shown: bool,
    pub revision_id: String,
    pub kind: String,
    pub number: u32,
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ToolError> {
    serde_json::from_value(args).map_err(ToolError::InvalidArguments)
}

fn encode(value: impl Serialize) -> Result<Value, ToolError> {
    serde_json::to_value(value).map_err(ToolError::Output)
}

/// The kinds the `build` tool offers a model: the registered kinds that build
/// with nothing but the printer. A kind that needs the CAD runtime is left
/// out, whether or not this app has one, until models get its script contract
/// with it; [`RequestActions::kinds`] is what the app itself can build.
fn offered_kinds() -> Vec<&'static dyn KindDriver> {
    kind::available(&KernelContext::without_runtime(P2S_04))
}

/// [`BuildArgs`]' schema with `kind` limited to the offered kinds and `spec`
/// to their specs, so a model sees each kind's exact shape.
fn build_parameters() -> Value {
    let mut schema = inlined_schema::<BuildArgs>();
    let offered = offered_kinds();
    let kinds: Vec<&str> = offered.iter().map(|kind| kind.id().as_str()).collect();
    let summaries: Vec<String> = offered.iter().map(|kind| format!("{}: {}", kind.id(), kind.summary())).collect();
    let specs: Vec<Value> = offered.iter().map(|kind| kind.spec_schema()).collect();
    schema["properties"]["kind"] = json!({
        "type": "string",
        "enum": kinds,
        "description": format!("What to build; each kind takes its own spec. {}.", summaries.join("; ")),
    });
    schema["properties"]["spec"] = json!({
        "description": "The complete spec for that kind.",
        "anyOf": specs,
    });
    schema
}

impl Tool {
    pub const ALL: [Tool; 5] = [Tool::Build, Tool::Get, Tool::List, Tool::Show, Tool::PrinterStatus];

    /// The tools offered on `surface`, in [`Tool::ALL`] order.
    pub fn on(surface: Surface) -> impl Iterator<Item = Tool> {
        Self::ALL.into_iter().filter(move |tool| tool.offered_on(surface))
    }

    fn offered_on(self, surface: Surface) -> bool {
        match (self, surface) {
            (Tool::Build | Tool::Get | Tool::List | Tool::Show | Tool::PrinterStatus, _) => true,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tool::Build => "build",
            Tool::Get => "get",
            Tool::List => "list",
            Tool::Show => "show",
            Tool::PrinterStatus => "printer_status",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Tool::Build => {
                "Build a design from a spec of one kind: validates the spec, builds the geometry, writes a Bambu 3MF, \
                 slices it with Bambu Studio for the P2S, and runs every verification check. Returns the revision \
                 summary (revision_id, kind, number, build: verified or failed, checks, warnings, approval). Repeating \
                 a design's latest revision returns it, and a spec that builds the same as an earlier verified build \
                 reuses that build (reused: true) instead of building again. A rejected spec returns an error that \
                 names the field to fix. The revision then waits for a person to approve it in the Materialize 3D \
                 app; this tool cannot approve it."
            }
            Tool::Get => "Get one design revision, including any failed verification checks and warnings.",
            Tool::List => {
                "List recent design revisions of every kind, newest first, with kind, build, approval, and print-test status."
            }
            Tool::Show => "Open a design revision in the Materialize 3D app so the person can review and approve it.",
            Tool::PrinterStatus => "Read the printer: connection, temperatures, G-code state, and job progress.",
        }
    }

    /// The inlined JSON Schema of this tool's arguments, built once.
    pub fn parameters(self) -> &'static Value {
        static BUILD: OnceLock<Value> = OnceLock::new();
        static LIST: OnceLock<Value> = OnceLock::new();
        static REVISION: OnceLock<Value> = OnceLock::new();
        static NO_ARGS: OnceLock<Value> = OnceLock::new();
        match self {
            Tool::Build => BUILD.get_or_init(build_parameters),
            Tool::List => LIST.get_or_init(inlined_schema::<ListArgs>),
            Tool::Get | Tool::Show => REVISION.get_or_init(inlined_schema::<RevisionArgs>),
            Tool::PrinterStatus => NO_ARGS.get_or_init(inlined_schema::<NoArgs>),
        }
    }

    /// Parses `args`, runs the shared action as the surface's [`RequestActor`], and
    /// returns the compact summary the model reads.
    pub async fn invoke(self, call: &ToolCall, args: Value) -> Result<Value, ToolError> {
        match self {
            Tool::Build => {
                let BuildArgs { kind, spec, lineage_id } = parse(args)?;
                let offered = offered_kinds();
                if !offered.iter().any(|offered| offered.id().as_str() == kind) {
                    let offered = offered.iter().map(|kind| kind.id().as_str()).collect::<Vec<_>>().join(", ");
                    return Err(ToolError::KindNotOffered { kind, offered });
                }
                let actor = call.surface.actor();
                let progress = call.progress.clone();
                let cancel = call.cancel.clone();
                let outcome = call
                    .run(move |actions| {
                        let cancelled = || cancel.is_cancelled();
                        let control = BuildControl::new(&*progress, &cancelled);
                        actions.build(&kind, spec, lineage_id.as_deref(), actor, &control)
                    })
                    .await?;
                encode(BuildResult { revision: DesignSummary::from(&outcome.revision), reused: outcome.reused })
            }
            Tool::List => {
                let ListArgs { limit } = parse(args)?;
                let ListLimit(limit) = limit.unwrap_or(ListLimit::DEFAULT);
                let revisions = call.run(move |actions| actions.list(limit)).await?;
                encode(revisions.iter().map(DesignSummary::from).collect::<Vec<_>>())
            }
            Tool::Get => {
                let RevisionArgs { revision_id } = parse(args)?;
                let revision = call.run(move |actions| actions.get(&revision_id)).await?;
                encode(DesignSummary::from(&revision))
            }
            Tool::Show => {
                let RevisionArgs { revision_id } = parse(args)?;
                let revision = call
                    .run(move |actions| {
                        let revision = actions.get(&revision_id)?;
                        actions.show(&revision_id)?;
                        Ok(revision)
                    })
                    .await?;
                encode(Shown { shown: true, revision_id: revision.id.to_string(), kind: revision.kind, number: revision.number })
            }
            Tool::PrinterStatus => {
                let NoArgs {} = parse(args)?;
                let p = call.run(|actions| actions.printer_status()).await?;
                Ok(json!({
                    "connected": p.is_connected,
                    "connection_state": p.connection_state,
                    "name": p.name,
                    "gcode_state": p.gcode_state,
                    "progress_percent": p.print_progress,
                    "remaining_minutes": p.remaining_time,
                    "layer": p.layer_num,
                    "total_layers": p.total_layer_num,
                    "job": p.subtask_name,
                    "temperatures_c": {
                        "nozzle": p.nozzle_temp,
                        "nozzle_target": p.nozzle_target_temp,
                        "bed": p.bed_temp,
                        "bed_target": p.bed_target_temp,
                        "chamber": p.chamber_temp,
                    },
                    "last_error": p.last_error,
                }))
            }
        }
    }
}

#[cfg(test)]
mod tests;
