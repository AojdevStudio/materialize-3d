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

use crate::actions::{ActionError, RequestActions, SignSummary};
use crate::fabrication::build::BuildStep;
use crate::fabrication::revisions::Actor;
use crate::fabrication::sign::SignSpec;

/// Where a model meets the tools. The surface fixes the caller's [`Actor`], so
/// no argument can claim to be someone else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    /// The Rig agent in the app's chat panel.
    InAppAgent,
    /// External agents over the local MCP endpoint.
    ExternalMcp,
}

impl Surface {
    fn actor(self) -> Actor {
        match self {
            Surface::InAppAgent => Actor::Agent,
            Surface::ExternalMcp => Actor::ExternalMcp,
        }
    }
}

/// Every tool a model can call. There is deliberately no approve, export, or
/// print-result tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    BuildSign,
    ListSigns,
    GetSign,
    ShowSign,
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
}

/// `build_sign` arguments. `spec` goes to [`RequestActions::build_sign`] unparsed so
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
    #[schemars(range(min = 1, max = 100))]
    limit: Option<ListLimit>,
}

/// How many revisions `list_signs` returns. Out of range is refused, never
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
fn inlined_schema<T: JsonSchema>() -> Value {
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

fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ToolError> {
    serde_json::from_value(args).map_err(ToolError::InvalidArguments)
}

fn encode(value: impl Serialize) -> Result<Value, ToolError> {
    serde_json::to_value(value).map_err(ToolError::Output)
}

impl Tool {
    pub const ALL: [Tool; 5] = [Tool::BuildSign, Tool::ListSigns, Tool::GetSign, Tool::ShowSign, Tool::PrinterStatus];

    /// The tools offered on `surface`, in [`Tool::ALL`] order.
    pub fn on(surface: Surface) -> impl Iterator<Item = Tool> {
        Self::ALL.into_iter().filter(move |tool| tool.offered_on(surface))
    }

    fn offered_on(self, surface: Surface) -> bool {
        match (self, surface) {
            (Tool::BuildSign | Tool::ListSigns | Tool::GetSign | Tool::ShowSign | Tool::PrinterStatus, _) => true,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tool::BuildSign => "build_sign",
            Tool::ListSigns => "list_signs",
            Tool::GetSign => "get_sign",
            Tool::ShowSign => "show_sign",
            Tool::PrinterStatus => "printer_status",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Tool::BuildSign => {
                "Build a sign from a spec: validates it, builds the face-down multicolor geometry, writes a Bambu 3MF, \
                 slices it with Bambu Studio for the P2S, and runs verification checks. Returns the revision summary \
                 (revision_id, number, build: verified or failed, checks, approval). An identical spec reuses the \
                 existing revision (reused: true) instead of building again. A rejected spec returns an error that \
                 names the field to fix. The revision then waits for a person to approve it in the Materialize 3D \
                 Signs view; this tool cannot approve it."
            }
            Tool::ListSigns => "List recent sign revisions, newest first, with build, approval, and print-test status.",
            Tool::GetSign => "Get one sign revision, including any failed verification checks.",
            Tool::ShowSign => {
                "Open a sign revision in the Materialize 3D Signs view so the person can review and approve it."
            }
            Tool::PrinterStatus => "Read the printer: connection, temperatures, G-code state, and job progress.",
        }
    }

    /// The inlined JSON Schema of this tool's arguments, built once.
    pub fn parameters(self) -> &'static Value {
        static BUILD_SIGN: OnceLock<Value> = OnceLock::new();
        static LIST_SIGNS: OnceLock<Value> = OnceLock::new();
        static REVISION: OnceLock<Value> = OnceLock::new();
        static NO_ARGS: OnceLock<Value> = OnceLock::new();
        match self {
            Tool::BuildSign => BUILD_SIGN.get_or_init(inlined_schema::<BuildSignArgs>),
            Tool::ListSigns => LIST_SIGNS.get_or_init(inlined_schema::<ListSignsArgs>),
            Tool::GetSign | Tool::ShowSign => REVISION.get_or_init(inlined_schema::<RevisionArgs>),
            Tool::PrinterStatus => NO_ARGS.get_or_init(inlined_schema::<NoArgs>),
        }
    }

    /// Parses `args`, runs the shared action as the surface's [`Actor`], and
    /// returns the compact summary the model reads.
    pub async fn invoke(self, call: &ToolCall, args: Value) -> Result<Value, ToolError> {
        match self {
            Tool::BuildSign => {
                let BuildSignArgs { spec, lineage_id } = parse(args)?;
                let actor = call.surface.actor();
                let progress = call.progress.clone();
                let cancel = call.cancel.clone();
                let outcome = call
                    .run(move |actions| {
                        actions.build_sign(spec, lineage_id.as_deref(), actor, &*progress, &|| cancel.is_cancelled())
                    })
                    .await?;
                encode(BuildResult { revision: SignSummary::from(&outcome.revision), reused: outcome.reused })
            }
            Tool::ListSigns => {
                let ListSignsArgs { limit } = parse(args)?;
                let ListLimit(limit) = limit.unwrap_or(ListLimit::DEFAULT);
                let signs = call.run(move |actions| actions.list_signs(limit)).await?;
                encode(signs.iter().map(SignSummary::from).collect::<Vec<_>>())
            }
            Tool::GetSign => {
                let RevisionArgs { revision_id } = parse(args)?;
                let revision = call.run(move |actions| actions.get_sign(&revision_id)).await?;
                encode(SignSummary::from(&revision))
            }
            Tool::ShowSign => {
                let RevisionArgs { revision_id } = parse(args)?;
                let revision = call
                    .run(move |actions| {
                        let revision = actions.get_sign(&revision_id)?;
                        actions.show_sign(&revision_id)?;
                        Ok(revision)
                    })
                    .await?;
                Ok(json!({ "shown": true, "revision_id": revision.id.to_string(), "number": revision.number }))
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
mod tests {
    use super::*;
    use crate::fabrication::build::BuildOutcome;
    use crate::fabrication::revisions::SignRevision;
    use crate::state::PrinterState;

    const FIXTURE: &str = include_str!("../tests/fixtures/signs/synthetic-back-shortly.json");

    fn build_sign_validator() -> jsonschema::Validator {
        jsonschema::validator_for(Tool::BuildSign.parameters()).expect("build_sign parameters are a valid schema")
    }

    #[test]
    fn no_tool_can_approve_export_or_record_a_print() {
        for tool in Tool::ALL {
            for forbidden in ["approve", "export", "print_result", "record_print"] {
                assert!(!tool.name().contains(forbidden), "{} must stay human-only", tool.name());
            }
        }
        assert!(Tool::ALL.iter().any(|tool| tool.name() == "printer_status"), "reading the printer stays legal");
    }

    /// Lists nothing and remembers each limit it was asked for; nothing else is reachable.
    #[derive(Default)]
    struct ListingActions {
        limits: std::sync::Mutex<Vec<u32>>,
    }

    impl RequestActions for ListingActions {
        fn build_sign(
            &self,
            _spec: Value,
            _lineage_id: Option<&str>,
            _actor: Actor,
            _progress: &dyn Fn(BuildStep),
            _is_cancelled: &dyn Fn() -> bool,
        ) -> Result<BuildOutcome, ActionError> {
            Err(ActionError::State("not in this test".into()))
        }

        fn list_signs(&self, limit: u32) -> Result<Vec<SignRevision>, ActionError> {
            self.limits.lock().expect("limits").push(limit);
            Ok(Vec::new())
        }

        fn get_sign(&self, _id: &str) -> Result<SignRevision, ActionError> {
            Err(ActionError::State("not in this test".into()))
        }

        fn show_sign(&self, _id: &str) -> Result<(), ActionError> {
            Err(ActionError::State("not in this test".into()))
        }

        fn printer_status(&self) -> Result<PrinterState, ActionError> {
            Err(ActionError::State("not in this test".into()))
        }
    }

    #[tokio::test]
    async fn list_signs_refuses_a_limit_outside_1_to_100_on_both_surfaces() {
        let schema = jsonschema::validator_for(Tool::ListSigns.parameters()).expect("list_signs schema");
        for surface in [Surface::InAppAgent, Surface::ExternalMcp] {
            let actions = Arc::new(ListingActions::default());
            let call = ToolCall {
                surface,
                actions: actions.clone(),
                progress: Arc::new(|_| {}),
                cancel: CancellationToken::new(),
                blocking: TaskTracker::new(),
            };
            for limit in [0, 101] {
                let args = json!({ "limit": limit });
                assert!(!schema.is_valid(&args), "{surface:?}: schema advertises limit {limit}");
                let refused = Tool::ListSigns.invoke(&call, args).await;
                assert!(
                    matches!(&refused, Err(ToolError::InvalidArguments(e)) if e.to_string().contains("1 to 100")),
                    "{surface:?}: limit {limit} gave {refused:?}"
                );
            }
            for limit in [1, 100] {
                let args = json!({ "limit": limit });
                assert!(schema.is_valid(&args), "{surface:?}: schema refuses limit {limit}");
                Tool::ListSigns.invoke(&call, args).await.expect("in-range limit");
            }
            Tool::ListSigns.invoke(&call, json!({})).await.expect("default limit");
            assert_eq!(*actions.limits.lock().expect("limits"), [1, 100, 20], "{surface:?}: limits passed through unchanged");
        }
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
