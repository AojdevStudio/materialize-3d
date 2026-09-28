//! The agent's tools: thin wrappers over the shared [`Actions`] functions.
//!
//! Every call is journaled as `started` before it runs, reported to the UI as
//! `ToolCall`, then `ToolProgress` (build_sign only), then `ToolResult`, and
//! journaled again with its outcome. A tool never fails the turn: errors go
//! back to the model and the UI as `{ "error": ... }` with `ok: false`.
//!
//! The agent reaches the app only through [`AgentActions`], which has no way
//! to approve, export, or record a print result. Those stay with people.

use std::future::Future;
use std::sync::Arc;

use rig::agent::tool::{DynamicTool, ToolOutput};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

use super::protocol::{AgentEvent, ToolCallStatus};
use super::store;
use crate::actions::{ActionError, Actions, SignSummary};
use crate::fabrication::build::{BuildOutcome, BuildStep};
use crate::fabrication::revisions::{Actor, SignRevision};
use crate::fabrication::sign::SignSpec;
use crate::state::{AppState, PrinterState};

/// What the agent may do in the app. [`Actions`] implements it for the running
/// app; tests substitute the build pipeline without a window.
pub trait AgentActions: Send + Sync + 'static {
    /// Blocking; see [`Actions::build_sign`].
    fn build_sign(
        &self,
        spec: Value,
        lineage_id: Option<&str>,
        actor: Actor,
        progress: &dyn Fn(BuildStep),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<BuildOutcome, ActionError>;
    fn list_signs(&self, limit: u32) -> Result<Vec<SignRevision>, ActionError>;
    fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError>;
    fn show_sign(&self, id: &str) -> Result<(), ActionError>;
    fn printer_status(&self) -> Result<PrinterState, ActionError>;
}

impl AgentActions for Actions {
    fn build_sign(
        &self,
        spec: Value,
        lineage_id: Option<&str>,
        actor: Actor,
        progress: &dyn Fn(BuildStep),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<BuildOutcome, ActionError> {
        Actions::build_sign(self, spec, lineage_id, actor, progress, is_cancelled)
    }

    fn list_signs(&self, limit: u32) -> Result<Vec<SignRevision>, ActionError> {
        Actions::list_signs(self, limit)
    }

    fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError> {
        Actions::get_sign(self, id)
    }

    fn show_sign(&self, id: &str) -> Result<(), ActionError> {
        Actions::show_sign(self, id)
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Actions::printer_status(self)
    }
}

/// Sends one event to the turn's listener.
pub type Emit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Everything one turn's tool calls share.
pub struct TurnScope {
    pub conversation_id: String,
    pub turn_id: String,
    pub state: Arc<AppState>,
    pub actions: Arc<dyn AgentActions>,
    pub emit: Emit,
    pub cancel: CancellationToken,
    /// Blocking work started by tools. Cancelling drops a tool's future but not
    /// its blocking thread, so the turn waits on this before it reports.
    pub blocking: TaskTracker,
}

impl TurnScope {
    /// Journals a call, reports it to the UI, runs `body`, and records the
    /// outcome. The returned value is what the model sees.
    async fn journaled<F, Fut>(&self, tool: AgentTool, args: Value, body: F) -> Value
    where
        F: FnOnce(String, Value) -> Fut,
        Fut: Future<Output = Result<Value, String>>,
    {
        let call_id = Uuid::new_v4().to_string();
        let name = tool.name();
        let journaled = store::with_conn(&self.state, |conn| {
            store::start_tool_call(conn, &call_id, &self.conversation_id, &self.turn_id, name, &args)
        });
        (self.emit)(AgentEvent::ToolCall { call_id: call_id.clone(), name: name.into(), args: args.clone() });

        // Nothing runs unless its start is on disk, so a restart can always tell.
        let result = match journaled {
            Ok(()) => body(call_id.clone(), args).await,
            Err(err) => Err(format!("could not record the tool call: {err}")),
        };
        let (ok, output, status) = match result {
            Ok(output) => (true, output, ToolCallStatus::Completed),
            Err(error) => (false, json!({ "error": error }), ToolCallStatus::Failed),
        };
        if let Err(err) = store::with_conn(&self.state, |conn| store::finish_tool_call(conn, &call_id, status, &output)) {
            log::error!("agent: recording tool call {call_id} outcome failed: {err}");
        }
        (self.emit)(AgentEvent::ToolResult { call_id, ok, output: output.clone() });
        output
    }
}

/// Every tool the agent can call. There is deliberately no approve, export, or
/// print-result tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTool {
    BuildSign,
    ListSigns,
    GetSign,
    ShowSign,
    PrinterStatus,
}

/// `build_sign` arguments. `spec` goes to [`Actions::build_sign`] unparsed so
/// the pipeline's own validation produces the error the model reads.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BuildSignArgs {
    /// The complete sign to build.
    #[schemars(with = "SignSpec")]
    spec: Value,
    /// Build a new revision of this existing sign (its `lineage_id`); omit for a new sign.
    #[serde(default)]
    lineage_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListSignsArgs {
    /// Most recent first; default 20, at most 100.
    #[serde(default)]
    limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RevisionArgs {
    /// A sign revision id (`revision_id` from build_sign or list_signs).
    revision_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct NoArgs {}

#[derive(Serialize)]
struct BuildResult {
    #[serde(flatten)]
    revision: SignSummary,
    /// True when an identical build already existed and was reused.
    reused: bool,
}

/// JSON Schema for `T` with every subschema inlined; providers differ in `$ref` support.
fn parameters_schema<T: JsonSchema>() -> Value {
    let generator = schemars::generate::SchemaSettings::draft2020_12()
        .with(|settings| settings.inline_subschemas = true)
        .into_generator();
    let mut schema = generator.into_root_schema_for::<T>().to_value();
    if let Some(object) = schema.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
    }
    schema
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("invalid arguments: {e}"))
}

fn to_value(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

impl AgentTool {
    pub const ALL: [AgentTool; 5] =
        [AgentTool::BuildSign, AgentTool::ListSigns, AgentTool::GetSign, AgentTool::ShowSign, AgentTool::PrinterStatus];

    pub fn name(self) -> &'static str {
        match self {
            AgentTool::BuildSign => "build_sign",
            AgentTool::ListSigns => "list_signs",
            AgentTool::GetSign => "get_sign",
            AgentTool::ShowSign => "show_sign",
            AgentTool::PrinterStatus => "printer_status",
        }
    }

    fn description(self) -> &'static str {
        match self {
            AgentTool::BuildSign => {
                "Build a sign from a spec: validates it, builds the face-down multicolor geometry, writes a Bambu 3MF, \
                 slices it with Bambu Studio for the P2S, and runs verification checks. Returns the revision summary \
                 (revision_id, number, build: verified or failed, checks, approval). An identical spec reuses the \
                 existing revision (reused: true) instead of building again. A rejected spec returns an error that \
                 names the field to fix."
            }
            AgentTool::ListSigns => "List recent sign revisions, newest first.",
            AgentTool::GetSign => "Get one sign revision, including any failed verification checks.",
            AgentTool::ShowSign => "Open a sign revision in the Signs view so the person can review and approve it.",
            AgentTool::PrinterStatus => {
                "Read the printer: connection, temperatures, G-code state, and job progress."
            }
        }
    }

    fn parameters(self) -> Value {
        match self {
            AgentTool::BuildSign => parameters_schema::<BuildSignArgs>(),
            AgentTool::ListSigns => parameters_schema::<ListSignsArgs>(),
            AgentTool::GetSign | AgentTool::ShowSign => parameters_schema::<RevisionArgs>(),
            AgentTool::PrinterStatus => parameters_schema::<NoArgs>(),
        }
    }

    pub(crate) async fn run(self, scope: &TurnScope, call_id: String, args: Value) -> Result<Value, String> {
        let actions = &scope.actions;
        match self {
            AgentTool::BuildSign => {
                let BuildSignArgs { spec, lineage_id } = parse(args)?;
                let actions = actions.clone();
                let emit = scope.emit.clone();
                let cancel = scope.cancel.clone();
                let outcome = scope
                    .blocking
                    .spawn_blocking(move || {
                        actions.build_sign(
                            spec,
                            lineage_id.as_deref(),
                            Actor::Agent,
                            &|step| emit(AgentEvent::ToolProgress { call_id: call_id.clone(), step }),
                            &|| cancel.is_cancelled(),
                        )
                    })
                    .await
                    .map_err(|e| format!("build task failed: {e}"))?
                    .map_err(|e| e.to_string())?;
                to_value(BuildResult { revision: SignSummary::from(&outcome.revision), reused: outcome.reused })
            }
            AgentTool::ListSigns => {
                let ListSignsArgs { limit } = parse(args)?;
                let signs = actions.list_signs(limit.unwrap_or(20).clamp(1, 100)).map_err(|e| e.to_string())?;
                to_value(signs.iter().map(SignSummary::from).collect::<Vec<_>>())
            }
            AgentTool::GetSign => {
                let RevisionArgs { revision_id } = parse(args)?;
                to_value(SignSummary::from(&actions.get_sign(&revision_id).map_err(|e| e.to_string())?))
            }
            AgentTool::ShowSign => {
                let RevisionArgs { revision_id } = parse(args)?;
                let revision = actions.get_sign(&revision_id).map_err(|e| e.to_string())?;
                actions.show_sign(&revision_id).map_err(|e| e.to_string())?;
                Ok(json!({ "shown": true, "revision_id": revision.id.to_string(), "number": revision.number }))
            }
            AgentTool::PrinterStatus => {
                let NoArgs {} = parse(args)?;
                let p = actions.printer_status().map_err(|e| e.to_string())?;
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

    /// The Rig registration for this tool, bound to one turn.
    pub fn bind(self, scope: Arc<TurnScope>) -> DynamicTool {
        DynamicTool::new(self.name(), self.description(), self.parameters(), move |_context, args| {
            let scope = scope.clone();
            Box::pin(async move {
                let output = scope.journaled(self, args, |call_id, args| self.run(&scope, call_id, args)).await;
                Ok(ToolOutput::json(output))
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/signs/synthetic-back-shortly.json");

    fn build_sign_validator() -> jsonschema::Validator {
        jsonschema::validator_for(&AgentTool::BuildSign.parameters()).expect("build_sign parameters are a valid schema")
    }

    #[test]
    fn build_sign_schema_accepts_the_fixture_spec() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
        let validator = build_sign_validator();
        let args = json!({ "spec": fixture });
        let errors: Vec<String> = validator.iter_errors(&args).map(|e| e.to_string()).collect();
        assert!(errors.is_empty(), "fixture rejected: {errors:?}");
    }

    #[test]
    fn build_sign_schema_rejects_malformed_specs() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
        let validator = build_sign_validator();
        let mutate = |f: &dyn Fn(&mut Value)| {
            let mut spec = fixture.clone();
            f(&mut spec);
            json!({ "spec": spec })
        };
        let bad = [
            ("missing inks", mutate(&|s| drop(s.as_object_mut().expect("object").remove("inks")))),
            ("unknown field", mutate(&|s| s["colour"] = json!("navy"))),
            ("unknown element type", mutate(&|s| s["elements"][1]["type"] = json!("circle"))),
            ("width as text", mutate(&|s| s["width_mm"] = json!("150"))),
            ("bad font weight", mutate(&|s| s["elements"][1]["font"] = json!("black"))),
            ("text without baseline", mutate(&|s| drop(s["elements"][1].as_object_mut().expect("text").remove("y_mm")))),
            ("no spec", json!({ "lineage_id": "x" })),
        ];
        for (why, args) in bad {
            assert!(!validator.is_valid(&args), "schema accepted a spec with {why}");
        }
    }
}
