//! Turn-level tests: the real turn runner, tools, and store, driven by a
//! scripted model. Tests marked `#[ignore]` need Bambu Studio
//! (`BAMBU_STUDIO_CLI`), and the live one also needs `OPENAI_API_KEY`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rig::test_utils::{MockCompletionModel, MockStreamEvent};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::commands::{choose_model, default_model, model_setting, models, offered_model};
use crate::fabrication::checks::{test_support, CheckId};
use crate::fabrication::kind::{find, KindDriver, View, KINDS};
use crate::fabrication::printer::P2S_04;
use crate::fabrication::revisions::{BuildFiles, Claim, NewRevision, Sha256Hex, SlicerIdentity};
use rig::completion::Message;
use super::protocol::{AgentErrorKind, AgentEvent, HistoryEntry, Provider, ToolCallStatus};
use super::store;
use super::tools::TurnScope;
use super::turn::{run_turn, ModelChoice, TurnEnd};
use crate::actions::{ActionError, RequestActions, RequestActor};
use crate::fabrication::kind::BuildControl;
use crate::fabrication::pipeline::{self, BuildError, BuildOutcome, BuildRequest, BuildStep, Workspace};
use crate::fabrication::revisions::{self, BuildState, LineageId, RevisionId, Revision};
use crate::state::{AppState, PrinterState};
use crate::tools::{Surface, Tool};

const FIXTURE: &str = include_str!("../../tests/fixtures/signs/synthetic-back-shortly.json");

struct Harness {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    conversation_id: String,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = AppState::default();
    *state.db.lock().expect("db lock") = Some(crate::database::init_db(&dir.path().join("test.db")).expect("init db"));
    let state = Arc::new(state);
    let conversation_id = store::with_conn(&state, |conn| store::current_conversation(conn)).expect("conversation");
    Harness { dir, state, conversation_id }
}

/// Collects every event of one turn. `cancel_on_progress` cancels the turn at
/// the first `ToolProgress` matching the step.
struct Turn {
    scope: Arc<TurnScope>,
    events: Arc<Mutex<Vec<AgentEvent>>>,
}

impl Turn {
    fn new(h: &Harness, turn_id: &str, actions: Arc<dyn RequestActions>, cancel_on_progress: Option<BuildStep>) -> Self {
        let events = Arc::new(Mutex::new(Vec::new()));
        let cancel = CancellationToken::new();
        let sink = events.clone();
        let trigger = cancel.clone();
        let scope = Arc::new(TurnScope {
            conversation_id: h.conversation_id.clone(),
            turn_id: turn_id.into(),
            state: h.state.clone(),
            actions,
            emit: Arc::new(move |event: AgentEvent| {
                if matches!(&event, AgentEvent::ToolProgress { step, .. } if Some(*step) == cancel_on_progress) {
                    trigger.cancel();
                }
                sink.lock().expect("events").push(event);
            }),
            cancel,
            blocking: TaskTracker::new(),
        });
        Turn { scope, events }
    }

    async fn run(&self, text: &str, model: Result<ModelChoice, TurnEnd>) -> Vec<AgentEvent> {
        tokio::time::timeout(Duration::from_secs(600), run_turn(self.scope.clone(), text.into(), model))
            .await
            .expect("turn ends");
        self.events.lock().expect("events").clone()
    }
}

fn kind(event: &AgentEvent) -> String {
    serde_json::to_value(event).expect("event json")["type"].as_str().expect("type").to_owned()
}

fn is_terminal(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::TurnFinished | AgentEvent::TurnCancelled | AgentEvent::Error { .. })
}

/// Every turn opens with `TurnStarted` and ends with exactly one terminal event.
fn assert_framed(events: &[AgentEvent]) {
    assert!(matches!(events.first(), Some(AgentEvent::TurnStarted { .. })), "first event: {:?}", events.first());
    assert_eq!(events.iter().filter(|e| is_terminal(e)).count(), 1, "one terminal event: {events:?}");
    assert!(is_terminal(events.last().expect("events")), "terminal event is last: {events:?}");
}

fn scripted(turns: Vec<Vec<MockStreamEvent>>) -> MockCompletionModel {
    MockCompletionModel::from_stream_turns(turns)
}

fn text_turn(text: &str) -> Vec<MockStreamEvent> {
    vec![MockStreamEvent::text(text), MockStreamEvent::final_response_with_default_usage()]
}

fn tool_turn(name: &str, args: Value) -> Vec<MockStreamEvent> {
    vec![MockStreamEvent::tool_call("tc-1", name, args), MockStreamEvent::final_response_with_default_usage()]
}

/// No designs; `build` reports its first step and then blocks until the turn
/// is cancelled, like a long slice.
#[derive(Default)]
struct FakeActions {
    build_exited: AtomicBool,
}

impl RequestActions for FakeActions {
    fn build(
        &self,
        _kind: &str,
        _spec: Value,
        _lineage_id: Option<&str>,
        _requester: RequestActor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        control.report(BuildStep::SpecValidated);
        while !control.is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(50));
        self.build_exited.store(true, Ordering::SeqCst);
        Err(ActionError::Build(BuildError::Cancelled))
    }

    fn build_next(
        &self,
        _kind: &str,
        _spec: Value,
        _lineage_id: &str,
        _requester: RequestActor,
        _control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Err(ActionError::State("FakeActions does not revise".into()))
    }

    fn list(&self, _limit: u32) -> Result<Vec<Revision>, ActionError> {
        Ok(Vec::new())
    }

    fn get(&self, id: &str) -> Result<Revision, ActionError> {
        Err(ActionError::State(format!("no design {id}")))
    }

    fn show(&self, _id: &str) -> Result<(), ActionError> {
        Ok(())
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Ok(PrinterState::default())
    }

    fn import_part(
        &self,
        _path: &std::path::Path,
        _title: &str,
        _units: crate::fabrication::kinds::imported_part::Units,
        _requester: RequestActor,
        _control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Err(ActionError::State("FakeActions does not import".into()))
    }

    fn exports(&self, _id: &str) -> Result<Vec<crate::fabrication::revisions::ExportRecord>, ActionError> {
        Ok(Vec::new())
    }

    /// Closed: no approval arrives through this fake.
    fn approvals(&self) -> tokio::sync::watch::Receiver<u64> {
        tokio::sync::watch::channel(0).1
    }

    fn kinds(&self) -> Vec<&'static dyn crate::fabrication::kind::KindDriver> {
        crate::fabrication::kind::available(&crate::fabrication::kind::KernelContext::without_runtime(crate::fabrication::printer::P2S_04))
    }

    fn views(&self, _revision: &Revision) -> pipeline::KeptViews {
        pipeline::KeptViews::default()
    }
}

/// The real build pipeline and revision store, without a window to notify.
struct PipelineActions {
    state: Arc<AppState>,
    workspace: Workspace,
}

impl PipelineActions {
    fn new(h: &Harness) -> Self {
        let root = h.dir.path();
        Self { state: h.state.clone(), workspace: Workspace::new(&root.join("data"), &root.join("cache")) }
    }
}

impl RequestActions for PipelineActions {
    fn build(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        let lineage_id = lineage_id.map(LineageId::parse).transpose()?;
        let request = BuildRequest { kind: kind.into(), spec, lineage_id, actor: requester.into() };
        Ok(pipeline::build(&self.state, &self.workspace, request, control)?)
    }

    fn build_next(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: &str,
        requester: RequestActor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        let request = BuildRequest { kind: kind.into(), spec, lineage_id: Some(LineageId::parse(lineage_id)?), actor: requester.into() };
        Ok(pipeline::build_next(&self.state, &self.workspace, request, control)?)
    }

    fn list(&self, limit: u32) -> Result<Vec<Revision>, ActionError> {
        Ok(pipeline::with_db(&self.state, |conn| revisions::list_recent(conn, limit))?)
    }

    fn get(&self, id: &str) -> Result<Revision, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::check_integrity(conn, &id))?)
    }

    fn show(&self, id: &str) -> Result<(), ActionError> {
        RevisionId::parse(id)?;
        Ok(())
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Ok(PrinterState::default())
    }

    fn import_part(
        &self,
        _path: &std::path::Path,
        _title: &str,
        _units: crate::fabrication::kinds::imported_part::Units,
        _requester: RequestActor,
        _control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Err(ActionError::State("PipelineActions does not import".into()))
    }

    fn exports(&self, _id: &str) -> Result<Vec<crate::fabrication::revisions::ExportRecord>, ActionError> {
        Ok(Vec::new())
    }

    /// Closed: no approval arrives through this fake.
    fn approvals(&self) -> tokio::sync::watch::Receiver<u64> {
        tokio::sync::watch::channel(0).1
    }

    fn kinds(&self) -> Vec<&'static dyn crate::fabrication::kind::KindDriver> {
        crate::fabrication::kind::available(&self.workspace.kernel_context())
    }

    fn views(&self, revision: &Revision) -> pipeline::KeptViews {
        pipeline::read_views(&self.workspace.builds_dir, revision)
    }
}

fn history(h: &Harness) -> Vec<HistoryEntry> {
    store::with_conn(&h.state, |conn| store::history(conn, &h.conversation_id)).expect("history")
}

fn model_history_json(h: &Harness) -> String {
    let history = store::with_conn(&h.state, |conn| store::model_history(conn, &h.conversation_id)).expect("model history");
    serde_json::to_string(&history).expect("json")
}

fn call_status(h: &Harness, call_id: &str) -> String {
    store::with_conn(&h.state, |conn| {
        Ok(conn.query_row("SELECT status FROM agent_tool_calls WHERE id = ?1", [call_id], |row| row.get(0))?)
    })
    .expect("call row")
}

fn tool_call_id(events: &[AgentEvent], tool: &str) -> String {
    events
        .iter()
        .find_map(|e| match e {
            AgentEvent::ToolCall { call_id, name, .. } if name == tool => Some(call_id.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no {tool} call in {events:?}"))
}

#[tokio::test]
async fn the_model_is_offered_exactly_the_registry_and_no_approval_tool() {
    let h = harness();
    let model = scripted(vec![text_turn("Hello.")]);
    let turn = Turn::new(&h, "t1", Arc::new(FakeActions::default()), None);
    turn.run("hi", Ok(ModelChoice::Scripted(model.clone()))).await;

    let mut offered: Vec<String> = model.requests()[0].tools.iter().map(|tool| tool.name.clone()).collect();
    offered.sort();
    let mut registry: Vec<String> = Tool::on(Surface::InAppAgent).map(|tool| tool.name().to_owned()).collect();
    registry.sort();
    assert_eq!(offered, registry);
    for name in &offered {
        for forbidden in ["approve", "export", "print_result", "record_print"] {
            assert!(!name.contains(forbidden), "tool {name} must not exist");
        }
    }
}

#[tokio::test]
async fn a_text_turn_streams_then_finishes_once_and_is_stored() {
    let h = harness();
    let turn = Turn::new(&h, "t1", Arc::new(FakeActions::default()), None);
    let events = turn.run("hi", Ok(ModelChoice::Scripted(scripted(vec![text_turn("Hello there.")])))).await;

    assert_framed(&events);
    assert_eq!(events.iter().map(kind).collect::<Vec<_>>(), ["turnStarted", "textDelta", "turnFinished"]);
    let entries = history(&h);
    assert!(matches!(&entries[..], [HistoryEntry::User { text: u, .. }, HistoryEntry::Assistant { text: a, .. }]
        if u == "hi" && a == "Hello there."));
}

#[tokio::test]
async fn a_tool_turn_reports_call_then_result_and_the_next_turn_sees_the_exchange() {
    let h = harness();
    let opening = Turn::new(&h, "t0", Arc::new(FakeActions::default()), None);
    opening.run("hello", Ok(ModelChoice::Scripted(scripted(vec![text_turn("Hi.")])))).await;

    let turn = Turn::new(&h, "t1", Arc::new(FakeActions::default()), None);
    let model = scripted(vec![tool_turn("list", json!({ "limit": 5 })), text_turn("No signs yet.")]);
    let events = turn.run("what signs exist?", Ok(ModelChoice::Scripted(model))).await;

    assert_framed(&events);
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["turnStarted", "toolCall", "toolResult", "textDelta", "turnFinished"]
    );
    let call_id = tool_call_id(&events, "list");
    assert!(matches!(&events[2], AgentEvent::ToolResult { call_id: id, ok: true, output } if *id == call_id && *output == json!([])));
    assert_eq!(call_status(&h, &call_id), "completed");
    assert!(matches!(
        &history(&h)[2..],
        [HistoryEntry::User { .. }, HistoryEntry::Tool { status: ToolCallStatus::Completed, .. }, HistoryEntry::Assistant { .. }]
    ));

    let next = scripted(vec![text_turn("Still none.")]);
    let turn = Turn::new(&h, "t2", Arc::new(FakeActions::default()), None);
    let events = turn.run("and now?", Ok(ModelChoice::Scripted(next.clone()))).await;
    assert_framed(&events);
    let seen = serde_json::to_string(&next.requests()[0].chat_history).expect("json");
    for said in ["hello", "Hi.", "what signs exist?", "No signs yet.", "and now?"] {
        assert!(seen.contains(said), "next turn's model input lacks {said:?}: {seen}");
    }
    assert!(!seen.contains("tool_call") && !seen.contains("tool_result"), "history replays text only: {seen}");
}

#[tokio::test]
async fn a_bad_tool_argument_goes_back_as_a_failed_result_without_ending_the_turn() {
    let h = harness();
    let turn = Turn::new(&h, "t1", Arc::new(FakeActions::default()), None);
    let model = scripted(vec![tool_turn("get", json!({ "id": "x" })), text_turn("Sorry.")]);
    let events = turn.run("show sign x", Ok(ModelChoice::Scripted(model))).await;

    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::TurnFinished)));
    let call_id = tool_call_id(&events, "get");
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolResult { call_id: id, ok: false, output }
        if *id == call_id && output["error"].as_str().is_some_and(|m| m.contains("invalid arguments")))));
    assert_eq!(call_status(&h, &call_id), "failed");
}

#[tokio::test]
async fn a_provider_error_ends_the_turn_with_one_error_and_nothing_said() {
    let h = harness();
    let turn = Turn::new(&h, "t1", Arc::new(FakeActions::default()), None);
    let model = scripted(vec![vec![MockStreamEvent::text("Partial"), MockStreamEvent::error("overloaded")]]);
    let events = turn.run("hi", Ok(ModelChoice::Scripted(model))).await;

    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::Error { kind: AgentErrorKind::Provider, .. })), "{events:?}");
    assert!(matches!(&history(&h)[..], [HistoryEntry::User { .. }]), "no assistant text is stored");
    assert!(!model_history_json(&h).contains("Partial"), "the model never sees its own half answer");
}

#[tokio::test]
async fn a_missing_api_key_fails_before_anything_is_sent_or_stored() {
    let h = harness();
    let model = choose_model(Provider::Openai, default_model(Provider::Openai).into(), None);
    assert!(matches!(&model, Err(TurnEnd::Failed { kind: AgentErrorKind::MissingApiKey, .. })));

    let turn = Turn::new(&h, "t1", Arc::new(FakeActions::default()), None);
    let events = turn.run("hi", model).await;
    assert_eq!(events.iter().map(kind).collect::<Vec<_>>(), ["turnStarted", "error"]);
    assert!(history(&h).is_empty());
}

#[test]
fn a_retired_model_reads_as_the_default_and_an_unknown_model_is_refused() {
    let h = harness();
    let read = |stored: &str| {
        store::with_conn(&h.state, |conn| {
            crate::database::upsert_setting(conn, "agent.model", stored).map_err(store::StoreError::Settings)?;
            model_setting(conn)
        })
        .expect("model setting")
    };
    assert_eq!(read("anthropic:claude-sonnet-5"), (Provider::Anthropic, "claude-opus-5-5".to_owned()));
    assert_eq!(read("openai:gpt-6.1-sol"), (Provider::Openai, "gpt-6.1-sol".to_owned()));

    assert_eq!(offered_model(Provider::Openai, ""), Ok("gpt-6-astra"));
    assert_eq!(offered_model(Provider::Anthropic, "claude-fable-5-1"), Ok("claude-fable-5-1"));
    let refused = offered_model(Provider::Openai, "gpt-5.5").expect_err("gpt-5.5 is retired");
    assert!(refused.contains("gpt-5.5"), "{refused}");
    assert!(offered_model(Provider::Openai, "claude-opus-5-5").is_err(), "a model of the other provider is refused");
}

#[tokio::test]
async fn cancel_mid_build_waits_for_the_build_and_marks_the_call_cancelled() {
    let h = harness();
    let actions = Arc::new(FakeActions::default());
    let turn = Turn::new(&h, "t1", actions.clone(), Some(BuildStep::SpecValidated));
    let spec: Value = serde_json::from_str(FIXTURE).expect("fixture");
    let model = scripted(vec![tool_turn("build", json!({ "kind": "sign", "spec": spec })), text_turn("Built it.")]);
    let events = turn.run("make the sign", Ok(ModelChoice::Scripted(model))).await;

    assert_framed(&events);
    assert!(actions.build_exited.load(Ordering::SeqCst), "the blocking build ended before the turn reported");
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["turnStarted", "toolCall", "toolProgress", "toolResult", "turnCancelled"]
    );
    let call_id = tool_call_id(&events, "build");
    assert!(matches!(&events[3], AgentEvent::ToolResult { call_id: id, ok: false, .. } if *id == call_id));
    assert_eq!(call_status(&h, &call_id), "cancelled");

    let entries = history(&h);
    assert!(matches!(&entries[..], [HistoryEntry::User { text, .. }, HistoryEntry::Tool { status: ToolCallStatus::Cancelled, .. }]
        if text == "make the sign"));
    let transcript = model_history_json(&h);
    assert!(transcript.contains("cancelled this request") && !transcript.contains("Built it."));
}

#[tokio::test]
#[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
async fn cancelled_real_build_fails_its_revision_and_re_asking_builds_once_then_reuses() {
    let h = harness();
    let actions: Arc<dyn RequestActions> = Arc::new(PipelineActions::new(&h));
    let spec: Value = serde_json::from_str(FIXTURE).expect("fixture");
    let build_turn = || scripted(vec![tool_turn("build", json!({ "kind": "sign", "spec": spec })), text_turn("Done.")]);

    let cancelled = Turn::new(&h, "t1", actions.clone(), Some(BuildStep::GeometryBuilt));
    let events = cancelled.run("make the sign", Ok(ModelChoice::Scripted(build_turn()))).await;
    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::TurnCancelled)));
    assert_eq!(call_status(&h, &tool_call_id(&events, "build")), "cancelled");
    let listed = actions.list(10).expect("list");
    assert!(matches!(&listed[..], [r] if matches!(&r.build, BuildState::Failed { reason, .. } if reason == "build cancelled")));

    let mut revisions = Vec::new();
    for turn_id in ["t2", "t3"] {
        let turn = Turn::new(&h, turn_id, actions.clone(), None);
        let events = turn.run("make the sign again", Ok(ModelChoice::Scripted(build_turn()))).await;
        assert_framed(&events);
        let output = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolResult { ok: true, output, .. } => Some(output.clone()),
                _ => None,
            })
            .expect("build result");
        println!("{turn_id}: {output}");
        assert_eq!(output["build"], "verified");
        revisions.push((output["revision_id"].clone(), output["reused"].clone()));
    }
    assert_eq!(revisions[0].0, revisions[1].0, "re-asking reuses the verified revision");
    assert_eq!((revisions[0].1.clone(), revisions[1].1.clone()), (json!(false), json!(true)));
    assert_eq!(actions.list(10).expect("list").len(), 2, "one cancelled and one verified revision, no duplicate");
}

/// Prints the event sequence with text deltas merged and truncated.
fn print_sequence(events: &[AgentEvent]) {
    let mut text = String::new();
    let flush = |text: &mut String| {
        if !text.is_empty() {
            let shown: String = text.chars().take(160).collect();
            println!("textDelta* {shown:?}{}", if text.chars().count() > 160 { " ..." } else { "" });
            text.clear();
        }
    };
    for event in events {
        if let AgentEvent::TextDelta { text: delta } = event {
            text.push_str(delta);
            continue;
        }
        flush(&mut text);
        let mut line = serde_json::to_value(event).expect("json");
        if let Some(args) = line.get_mut("args").filter(|a| a.to_string().len() > 160) {
            *args = json!(format!("{}...", &args.to_string()[..160]));
        }
        println!("{line}");
    }
    flush(&mut text);
}

/// Runs once for every offered OpenAI model, so each one is proven to build.
#[tokio::test]
#[ignore = "live: needs OPENAI_API_KEY and a validated Bambu Studio"]
async fn live_openai_turn_builds_a_verified_sign() {
    let api_key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY");
    for model in models(Provider::Openai) {
        println!("model: openai:{model}");
        let h = harness();
        let actions: Arc<dyn RequestActions> = Arc::new(PipelineActions::new(&h));
        let turn = Turn::new(&h, "live-1", actions, None);
        let events = turn
            .run(
                "Make a 150 x 210 mm door sign that says BACK SHORTLY in navy on white with a teal rule under it",
                choose_model(Provider::Openai, (*model).into(), Some(api_key.clone())),
            )
            .await;
        print_sequence(&events);

        assert_framed(&events);
        assert!(matches!(events.last(), Some(AgentEvent::TurnFinished)), "{model}: {:?}", events.last());
        tool_call_id(&events, "build");
        let steps: Vec<BuildStep> = events
            .iter()
            .filter_map(|e| match e {
                AgentEvent::ToolProgress { step, .. } => Some(*step),
                _ => None,
            })
            .collect();
        assert!(steps.contains(&BuildStep::Sliced), "{model}: build progress reported: {steps:?}");
        assert!(
            events.iter().any(|e| matches!(e, AgentEvent::ToolResult { ok: true, output, .. } if output["build"] == "verified")),
            "{model}: a build result carries a verified revision"
        );
    }
}

// ─── Parts: describe, build, repair, revise ────────────────────────────────

/// The real revision store and the real kinds' validation, with the CAD
/// worker and the slicer scripted, so a turn can design a part with no VM,
/// no slicer, and no keys. Lineages, numbering, and reuse are the real
/// `revisions::claim`. A script with a line that holds `radius=99` fails at
/// stage generate on that line, as a too-large fillet does; anything else
/// verifies with an isometric, a front, and a top view.
pub(crate) struct ScriptedBuilds {
    state: Arc<AppState>,
    dir: std::path::PathBuf,
    kinds: Vec<&'static dyn KindDriver>,
    /// The specs that ran, in order; reused builds never run.
    pub(crate) ran: Mutex<Vec<Value>>,
    pub(crate) shown: Mutex<Vec<String>>,
}

impl ScriptedBuilds {
    /// An app that can build every registered kind, `part` included.
    pub(crate) fn new(state: Arc<AppState>, dir: &std::path::Path) -> Self {
        Self { state, dir: dir.join("builds"), kinds: KINDS.to_vec(), ran: Mutex::default(), shown: Mutex::default() }
    }

    /// Runs the scripted kernel for a claimed build and records how it ended.
    fn run(&self, revision: &Revision, spec: &Value) -> Result<(), ActionError> {
        self.ran.lock().expect("ran").push(spec.clone());
        let source = spec["source"].as_str().unwrap_or_default();
        if let Some((line, _)) = source.lines().enumerate().find(|(_, text)| text.contains("radius=99")) {
            let reason = BuildError::Stage {
                stage: crate::fabrication::pipeline::Stage::Generate,
                error: format!("line {}: ValueError: Failed creating a fillet with radius 99", line + 1),
            }
            .to_string();
            return Ok(pipeline::with_db(&self.state, |conn| revisions::fail_build(conn, &revision.build_id, &reason))?);
        }
        let dir = self.dir.join(revision.build_id.as_str());
        std::fs::create_dir_all(&dir).map_err(|e| ActionError::State(e.to_string()))?;
        let write = |name: &str, bytes: &[u8]| std::fs::write(dir.join(name), bytes).map_err(|e| ActionError::State(e.to_string()));
        for view in [View::Isometric, View::Front, View::Top] {
            write(&view.file_name(), format!("png:{}:{}", view.as_str(), revision.build_key).as_bytes())?;
        }
        write("preview.png", b"preview")?;
        let package = revision.build_key.as_str().as_bytes();
        write("part.3mf", package)?;
        let files = BuildFiles {
            revision_dir: dir.clone(),
            package_path: dir.join("part.3mf"),
            package_sha256: Sha256Hex::of_bytes(package),
            preview_path: dir.join("preview.png"),
            slice_dir: dir.join("slice"),
            gcode_sha256: Sha256Hex::of_bytes(b"gcode"),
            slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "scripted".into() },
            effective_settings: Value::Null,
            size_mm: Some([60.0, 25.0, 26.8]),
        };
        let requirement = CheckId::try_from("geometry.requirement.0".to_owned()).expect("id");
        let overhang = CheckId::try_from("print.overhang.clip".to_owned()).expect("id");
        let passed = test_support::with_warnings(&[requirement, overhang.clone()], &[overhang]);
        Ok(pipeline::with_db(&self.state, |conn| revisions::finish_verified(conn, &revision.build_id, files, &passed))?)
    }
}

impl ScriptedBuilds {
    /// The pipeline's order: find the kind, validate, claim with `claim`, run.
    fn build_with(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        control: &BuildControl<'_>,
        claim: fn(&mut rusqlite::Connection, &NewRevision) -> revisions::Result<Claim>,
    ) -> Result<BuildOutcome, ActionError> {
        let driver = find(kind).ok_or_else(|| BuildError::UnknownKind(kind.into()))?;
        let parsed = driver.parse(spec.clone(), &P2S_04).map_err(BuildError::Spec)?;
        control.report(BuildStep::SpecValidated);
        let request = NewRevision {
            lineage_id: lineage_id.map(LineageId::parse).transpose()?,
            kind: parsed.kind(),
            title: parsed.title().to_owned(),
            spec: spec.clone(),
            spec_sha256: parsed.spec_sha256().clone(),
            build_key: Sha256Hex::of_bytes(format!("{}\n{}", parsed.tag(), parsed.spec_sha256()).as_bytes()),
            check_plan: test_support::PLAN,
            requested_by: requester.into(),
        };
        let revision = match pipeline::with_db(&self.state, |conn| claim(conn, &request))? {
            Claim::Started(revision) => revision,
            Claim::Reused(revision) => return Ok(BuildOutcome { revision, reused: true }),
            Claim::Busy(build) => return Err(ActionError::State(format!("build {build} is running"))),
        };
        self.run(&revision, &spec)?;
        let revision = pipeline::with_db(&self.state, |conn| revisions::get(conn, &revision.id))?;
        if matches!(revision.build, BuildState::Verified { .. }) {
            control.report(BuildStep::Verified);
        }
        Ok(BuildOutcome { revision, reused: false })
    }
}

impl RequestActions for ScriptedBuilds {
    fn build(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        self.build_with(kind, spec, lineage_id, requester, control, revisions::claim)
    }

    fn build_next(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: &str,
        requester: RequestActor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        self.build_with(kind, spec, Some(lineage_id), requester, control, revisions::claim_next)
    }

    fn list(&self, limit: u32) -> Result<Vec<Revision>, ActionError> {
        Ok(pipeline::with_db(&self.state, |conn| revisions::list_recent(conn, limit))?)
    }

    fn get(&self, id: &str) -> Result<Revision, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::check_integrity(conn, &id))?)
    }

    fn show(&self, id: &str) -> Result<(), ActionError> {
        self.shown.lock().expect("shown").push(id.to_owned());
        Ok(())
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Ok(PrinterState::default())
    }

    fn import_part(
        &self,
        _path: &std::path::Path,
        _title: &str,
        _units: crate::fabrication::kinds::imported_part::Units,
        _requester: RequestActor,
        _control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Err(ActionError::State("ScriptedBuilds does not import".into()))
    }

    fn exports(&self, _id: &str) -> Result<Vec<crate::fabrication::revisions::ExportRecord>, ActionError> {
        Ok(Vec::new())
    }

    /// Closed: no approval arrives through this fake.
    fn approvals(&self) -> tokio::sync::watch::Receiver<u64> {
        tokio::sync::watch::channel(0).1
    }

    fn kinds(&self) -> Vec<&'static dyn KindDriver> {
        self.kinds.clone()
    }

    fn views(&self, revision: &Revision) -> pipeline::KeptViews {
        pipeline::read_views(&self.dir, revision)
    }
}

/// The design's cable clip script (design.md, Usage), with the fillet first.
pub(crate) const CLIP_SCRIPT: &str = "\
from build123d import *
from materialize import Body

def build(p):
    slot = p[\"cable_d\"] + 2 * p[\"clearance\"]
    jaw = p[\"desk_t\"] + p[\"clearance\"]
    height = p[\"wall\"] + jaw + slot / 2 + p[\"wall\"]
    with BuildPart() as clip:
        Box(p[\"span\"], p[\"depth\"], height, align=(Align.CENTER, Align.MIN, Align.MIN))
        fillet(clip.edges().filter_by(Axis.X), radius=p[\"fillet\"])
    return [Body(\"clip\", slot=1, part=clip.part)]
";

/// The clip spec with `source` as its script.
pub(crate) fn clip(source: &str) -> Value {
    let mut spec = crate::fabrication::kinds::part::tests::clip_spec();
    spec["source"] = json!(source);
    spec
}

fn tool_turn_as(id: &str, name: &str, args: Value) -> Vec<MockStreamEvent> {
    vec![MockStreamEvent::tool_call(id, name, args), MockStreamEvent::final_response_with_default_usage()]
}

/// One scripted reply, made from the request it answers.
type Reply = Box<dyn Fn(&rig::completion::CompletionRequest) -> Vec<MockStreamEvent> + Send + Sync>;

/// A scripted model like [`MockCompletionModel`], except that each reply is
/// made from the request it answers, so a model can pass on an id it read in
/// an earlier tool result, as a real one does.
#[derive(Clone)]
pub struct Responder {
    replies: Arc<Mutex<std::collections::VecDeque<Reply>>>,
    requests: Arc<Mutex<Vec<rig::completion::CompletionRequest>>>,
}

impl Responder {
    fn new(replies: Vec<Reply>) -> Self {
        Self { replies: Arc::new(Mutex::new(replies.into())), requests: Arc::default() }
    }

    fn requests(&self) -> Vec<rig::completion::CompletionRequest> {
        self.requests.lock().expect("requests").clone()
    }
}

impl rig::completion::CompletionModel for Responder {
    async fn completion(
        &self,
        _request: rig::completion::CompletionRequest,
    ) -> Result<rig::completion::CompletionResponse, rig::completion::CompletionError> {
        Err(rig::completion::CompletionError::ProviderError("the responder only streams".into()))
    }

    async fn stream(
        &self,
        request: rig::completion::CompletionRequest,
    ) -> Result<rig::streaming::StreamingCompletionResponse, rig::completion::CompletionError> {
        self.requests.lock().expect("requests").push(request.clone());
        let reply = self.replies.lock().expect("replies").pop_front();
        let Some(reply) = reply else {
            return Err(rig::completion::CompletionError::ProviderError("the responder has no reply left".into()));
        };
        let events = reply(&request);
        MockCompletionModel::from_stream_turns([events]).stream(request).await
    }
}

/// A reply that is the same whatever the request.
fn fixed(events: Vec<MockStreamEvent>) -> Reply {
    Box::new(move |_| events.clone())
}

/// The `ok` results of `tool`'s calls in one turn, in order.
fn results_of(events: &[AgentEvent], tool: &str) -> Vec<Value> {
    let ids: Vec<&String> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolCall { call_id, name, .. } if name == tool => Some(call_id),
            _ => None,
        })
        .collect();
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolResult { call_id, output, .. } if ids.contains(&call_id) => Some(output.clone()),
            _ => None,
        })
        .collect()
}

/// The tool results a model request carries, newest last: each one's JSON
/// and how many images ride with it.
fn tool_results_in(request: &rig::completion::CompletionRequest) -> Vec<(Value, usize)> {
    use rig::completion::message::{ToolResultContent, UserContent};
    request
        .chat_history
        .iter()
        .filter_map(|message| match message {
            Message::User { content } => Some(content),
            _ => None,
        })
        .flatten()
        .filter_map(|content| match content {
            UserContent::ToolResult(result) => Some(result),
            _ => None,
        })
        .map(|result| {
            let json = result
                .content
                .iter()
                .find_map(|part| match part {
                    ToolResultContent::Json { value } => Some(value.clone()),
                    _ => None,
                })
                .unwrap_or(Value::Null);
            let images = result.content.iter().filter(|part| matches!(part, ToolResultContent::Image(_))).count();
            (json, images)
        })
        .collect()
}

/// A scripted model describes `part`, builds a clip whose fillet fails at
/// generate, repairs it in the same turn, and in the next turn revises it.
/// Every build result carries the view set to the model, the failure names
/// its stage, and the revise is revision n+1 built from the patched spec.
#[tokio::test]
async fn a_scripted_model_describes_builds_repairs_and_revises_a_part() {
    let h = harness();
    let actions = Arc::new(ScriptedBuilds::new(h.state.clone(), h.dir.path()));
    let failing = clip(&CLIP_SCRIPT.replace("radius=p[\"fillet\"]", "radius=99"));
    // The repair reads the failed build's lineage_id from its tool result, as the prompt asks.
    let repair: Reply = Box::new(|request| {
        let (failed, _) = tool_results_in(request).last().cloned().expect("the failed build's result");
        tool_turn_as("tc-repair", "build", json!({ "kind": "part", "spec": clip(CLIP_SCRIPT), "lineage_id": failed["lineage_id"] }))
    });
    let model = Responder::new(vec![
        fixed(tool_turn_as("tc-describe", "describe_kind", json!({ "kind": "part" }))),
        fixed(tool_turn_as("tc-build", "build", json!({ "kind": "part", "spec": failing }))),
        repair,
        fixed(text_turn("Revision 2 verified: 1/1 checks, one overhang warning. It waits for your approval in the app.")),
    ]);
    let turn = Turn::new(&h, "t1", actions.clone(), None);
    let events = turn.run("a clip for six 4 mm cables on an 18 mm desk, 60 mm wide", Ok(ModelChoice::Responding(model.clone()))).await;
    print_sequence(&events);
    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::TurnFinished)), "{:?}", events.last());

    let described = &results_of(&events, "describe_kind")[0];
    assert_eq!(described["kind"], "part");
    assert!(described["guide"].as_str().is_some_and(|g| g.contains("A worked example")), "{described}");

    let builds = results_of(&events, "build");
    let (failed, repaired) = (&builds[0], &builds[1]);
    assert_eq!((failed["build"].as_str(), failed["stage"].as_str()), (Some("failed"), Some("generate")), "{failed}");
    let reason = failed["failure_reason"].as_str().expect("reason");
    assert_eq!(reason, "generate: line 10: ValueError: Failed creating a fillet with radius 99");
    assert_eq!((failed["number"].clone(), failed["views"].clone()), (json!(1), json!([])), "no views of a failed script");
    assert_eq!(repaired["build"], "verified", "{repaired}");
    assert_eq!(repaired["stage"], Value::Null);
    assert_eq!(
        (repaired["number"].clone(), repaired["lineage_id"].clone()),
        (json!(2), failed["lineage_id"].clone()),
        "the repair is the failed design's next revision"
    );
    assert_eq!(repaired["size_mm"], json!([60.0, 25.0, 26.8]));
    assert_eq!(repaired["views_missing"], json!([]));
    assert_eq!(repaired["views"], json!(["isometric", "front", "top"]));
    assert_eq!(repaired["warnings"], json!(["print.overhang.clip: ok"]));
    assert_eq!(repaired["requirements"], json!(["ok"]));
    assert_eq!(repaired["shown"], true, "the in-app agent's build opens for the person");
    assert_eq!(actions.shown.lock().expect("shown").len(), 2, "both revisions were opened");
    let steps: Vec<BuildStep> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolProgress { step, .. } => Some(*step),
            _ => None,
        })
        .collect();
    assert_eq!(steps, [BuildStep::SpecValidated, BuildStep::SpecValidated, BuildStep::Verified], "only the repair verified");

    // What the model read: the repair request sees the failure as JSON with
    // its stage; the reply request sees the repaired build with its three views.
    let requests = model.requests();
    assert_eq!(requests.len(), 4, "describe, build, repair, reply");
    let seen = tool_results_in(&requests[2]);
    assert_eq!((seen.last().expect("failure")).0["stage"], "generate");
    assert_eq!(seen.last().expect("failure").1, 0);
    let seen = tool_results_in(&requests[3]);
    let (json, images) = seen.last().expect("repair result");
    assert_eq!((json["build"].as_str(), *images), (Some("verified"), 3), "the view set rides in the tool result");

    let stored: String = store::with_conn(&h.state, |conn| {
        Ok(conn.query_row("SELECT group_concat(rig_json, '') FROM agent_messages", [], |row| row.get(0))?)
    })
    .expect("stored transcripts");
    assert!(stored.contains("describe_kind"), "the turn's transcript keeps its tool calls: {stored}");
    assert!(!stored.contains(&crate::tools::base64(b"png:isometric")[..16]), "no view image is stored in a transcript");

    // Next turn: the history is text only, plus the focus record of the repair.
    let repair = repaired["revision_id"].as_str().expect("id").to_owned();
    let model = scripted(vec![
        tool_turn_as("tc-revise", "revise", json!({ "revision_id": repair, "changes": { "params": { "span": 65 } } })),
        text_turn("Revision 3 is 65 mm wide."),
    ]);
    let turn = Turn::new(&h, "t2", actions.clone(), None);
    let events = turn.run("make it 65 mm wide", Ok(ModelChoice::Scripted(model.clone()))).await;
    assert_framed(&events);
    let first = &model.requests()[0];
    let said: Vec<&Message> = first.chat_history.iter().filter(|m| !matches!(m, Message::System { .. })).collect();
    let history = serde_json::to_string(&said).expect("json");
    for absent in ["tool_call", "tool_result", "\"image\"", "tc-build"] {
        assert!(!history.contains(absent), "history replays {absent}: {history}");
    }
    assert!(history.contains("a clip for six 4 mm cables") && history.contains("Revision 2 verified"), "{history}");
    let stored = crate::fabrication::kind::canonical_json(&clip(CLIP_SCRIPT));
    let focus = format!("[Focus: the last revision is {repair} (kind part, revision 2), spec {stored}]");
    let Some(Message::User { content }) = said.last() else { panic!("the prompt is last: {said:?}") };
    let texts: Vec<&str> = content
        .iter()
        .filter_map(|c| match c {
            rig::completion::message::UserContent::Text(t) => Some(t.text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, [focus.as_str(), "make it 65 mm wide"], "the focus record leads the prompt");
    let stored_prompt = store::with_conn(&h.state, |conn| store::model_history(conn, &h.conversation_id)).expect("history");
    assert!(!serde_json::to_string(&stored_prompt).expect("json").contains("[Focus:"), "the focus record is never stored");
    let revised = &results_of(&events, "revise")[0];
    assert_eq!((revised["number"].clone(), revised["build"].clone(), revised["reused"].clone()), (json!(3), json!("verified"), json!(false)));
    assert_eq!(revised["lineage_id"], repaired["lineage_id"], "revise adds to the repaired design");
    assert_eq!(actions.ran.lock().expect("ran").last().expect("ran")["params"]["span"], json!(65), "revision 3 built the patched spec");
    let (_, images) = tool_results_in(&model.requests()[1]).last().cloned().expect("revise result");
    assert_eq!(images, 3, "revise carries the view set too");
}

/// A merge patch makes revision n+1: a params patch, a source patch whose
/// build runs the new code, a patch back to an earlier spec that reuses its
/// build, and an invalid patch refused exactly like the fresh invalid spec.
#[tokio::test]
async fn revise_applies_a_merge_patch_as_revision_n_plus_1() {
    let h = harness();
    let actions = Arc::new(ScriptedBuilds::new(h.state.clone(), h.dir.path()));
    let call = crate::tools::ToolCall {
        surface: Surface::ExternalMcp,
        actions: actions.clone(),
        progress: Arc::new(|_| {}),
        cancel: CancellationToken::new(),
        blocking: TaskTracker::new(),
    };
    let first = Tool::Build.invoke(&call, json!({ "kind": "part", "spec": clip(CLIP_SCRIPT) })).await.expect("build").value;
    let revise = |id: &Value, changes: Value| {
        let args = json!({ "revision_id": id, "changes": changes });
        let call = &call;
        async move { Tool::Revise.invoke(call, args).await }
    };

    let wider = revise(&first["revision_id"], json!({ "params": { "span": 65 } })).await.expect("revise").value;
    assert_eq!((wider["number"].clone(), wider["reused"].clone(), wider["shown"].clone()), (json!(2), json!(false), json!(false)));
    let ran = actions.ran.lock().expect("ran").last().cloned().expect("ran");
    assert_eq!(ran["params"]["span"], json!(65));
    assert_eq!(ran["params"]["cables"], json!(6), "params the patch did not name keep their values");

    let source = CLIP_SCRIPT.replace("fillet(clip.edges().filter_by(Axis.X)", "chamfer(clip.edges().filter_by(Axis.X)");
    let reshaped = revise(&wider["revision_id"], json!({ "source": source })).await.expect("revise source").value;
    assert_eq!((reshaped["number"].clone(), reshaped["reused"].clone()), (json!(3), json!(false)));
    let ran = actions.ran.lock().expect("ran").last().cloned().expect("ran");
    assert_eq!(ran["source"], json!(source), "revision 3's build ran the new code");
    assert_eq!(ran["params"]["span"], json!(65), "on revision 2's params");

    let back = revise(&reshaped["revision_id"], json!({ "source": CLIP_SCRIPT, "params": { "span": 60 } })).await.expect("revise back").value;
    assert_eq!((back["number"].clone(), back["reused"].clone()), (json!(4), json!(true)), "the earlier spec's build is reused");
    assert_eq!(back["package_sha256"], first["package_sha256"]);
    assert_eq!(actions.ran.lock().expect("ran").len(), 3, "nothing ran for revision 4");

    let invalid = json!({ "filaments": [] });
    let refused = revise(&back["revision_id"], invalid.clone()).await.expect_err("an empty filament list is refused");
    let patched = crate::actions::merge_patch(clip(CLIP_SCRIPT), &invalid);
    let fresh = Tool::Build.invoke(&call, json!({ "kind": "part", "spec": patched })).await.expect_err("refused fresh");
    assert_eq!(refused.to_string(), fresh.to_string(), "a patch is validated like a fresh spec");
    assert_eq!(actions.list(10).expect("list").len(), 4, "a refused spec records no revision");
}

/// Revise never carries an approval forward. An empty patch on the approved
/// revision is refused, and a patch that brings an older revision back to the
/// approved spec is a new revision on the approved build, waiting for its own
/// approval.
#[tokio::test]
async fn revise_always_makes_a_new_pending_revision_and_never_reuses_an_approval() {
    use std::collections::BTreeSet;
    let h = harness();
    let actions = Arc::new(ScriptedBuilds::new(h.state.clone(), h.dir.path()));
    let call = crate::tools::ToolCall {
        surface: Surface::ExternalMcp,
        actions: actions.clone(),
        progress: Arc::new(|_| {}),
        cancel: CancellationToken::new(),
        blocking: TaskTracker::new(),
    };
    let first = Tool::Build.invoke(&call, json!({ "kind": "part", "spec": clip(CLIP_SCRIPT) })).await.expect("build").value;
    let revise = |id: &Value, changes: Value| {
        let args = json!({ "revision_id": id, "changes": changes });
        let call = &call;
        async move { Tool::Revise.invoke(call, args).await }
    };
    let wider = revise(&first["revision_id"], json!({ "params": { "span": 65 } })).await.expect("revise").value;

    let approved_id = RevisionId::parse(wider["revision_id"].as_str().expect("id")).expect("id");
    let hash = Sha256Hex::try_from(wider["package_sha256"].as_str().expect("hash").to_owned()).expect("hash");
    let warnings = BTreeSet::from([CheckId::try_from("print.overhang.clip".to_owned()).expect("id")]);
    pipeline::with_db(&h.state, |conn| revisions::approve(conn, &approved_id, &hash, &warnings, revisions::Actor::Human)).expect("a person approves");

    for empty in [json!({}), json!({ "params": { "span": 65 } })] {
        let refused = revise(&wider["revision_id"], empty.clone()).await.expect_err("a patch that changes nothing");
        assert!(refused.to_string().contains("the changes leave revision 2's spec as it is"), "{empty}: {refused}");
    }

    let back = revise(&first["revision_id"], json!({ "params": { "span": 65 } })).await.expect("revise to the approved spec").value;
    assert_eq!((back["number"].clone(), back["approval"].clone()), (json!(3), json!("pending")), "{back}");
    assert_ne!(back["revision_id"], wider["revision_id"]);
    assert_eq!((back["reused"].clone(), back["package_sha256"].clone()), (json!(true), wider["package_sha256"].clone()), "the approved build, not its approval");
    let approved = actions.get(approved_id.as_str()).expect("revision 2");
    assert!(matches!(approved.approval, revisions::Approval::Approved { .. }), "revision 2 keeps its own approval");
    assert_eq!(actions.list(10).expect("list").len(), 3, "the refused patches recorded nothing");
}

/// When the model asks a question instead of building, the turn ends after
/// that one reply: nothing forces a tool call, and nothing is built.
#[tokio::test]
async fn a_clarifying_question_ends_the_turn_without_a_build() {
    let h = harness();
    let actions = Arc::new(ScriptedBuilds::new(h.state.clone(), h.dir.path()));
    let model = scripted(vec![text_turn("Is 60 mm the desk thickness or the width along the edge, and how thick are the cables?")]);
    let turn = Turn::new(&h, "t1", actions.clone(), None);
    let events = turn.run("a cable organizer for six USB-C cables on a 60 mm desk edge", Ok(ModelChoice::Scripted(model.clone()))).await;

    assert_framed(&events);
    assert_eq!(events.iter().map(kind).collect::<Vec<_>>(), ["turnStarted", "textDelta", "turnFinished"]);
    let requests = model.requests();
    assert_eq!(requests.len(), 1, "one model call, then the turn waits for the person");
    assert!(requests[0].tool_choice.is_none(), "no tool call is required: {:?}", requests[0].tool_choice);
    let system = serde_json::to_string(&requests[0]).expect("json");
    assert!(system.contains("If a fit-critical dimension is missing or ambiguous, ask before building."), "{system}");
    assert!(actions.ran.lock().expect("ran").is_empty() && actions.list(10).expect("list").is_empty());
}

/// A model that never stops failing is cut off at `MAX_TURNS` model calls
/// with one error, and every build it asked for is on record.
#[tokio::test]
async fn the_repair_loop_is_bounded_by_max_turns() {
    use super::turn::MAX_TURNS;
    let h = harness();
    let actions = Arc::new(ScriptedBuilds::new(h.state.clone(), h.dir.path()));
    let failing = clip(&CLIP_SCRIPT.replace("radius=p[\"fillet\"]", "radius=99"));
    let turns = (0..MAX_TURNS + 2).map(|i| tool_turn_as(&format!("tc-{i}"), "build", json!({ "kind": "part", "spec": failing }))).collect();
    let model = scripted(turns);
    let turn = Turn::new(&h, "t1", actions.clone(), None);
    let events = turn.run("make the clip", Ok(ModelChoice::Scripted(model.clone()))).await;

    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::Error { .. })), "{:?}", events.last());
    assert_eq!(model.requests().len(), MAX_TURNS);
    assert_eq!(results_of(&events, "build").len(), MAX_TURNS, "each call's build ran and reported");
}

/// The in-app tool result and the MCP result carry the same JSON and the same
/// images, in the same order.
#[tokio::test]
async fn mcp_returns_the_same_content_as_the_in_app_tool_result() {
    use rig::completion::message::{DocumentSourceKind, ToolResultContent};
    let h = harness();
    let actions: Arc<dyn RequestActions> = Arc::new(ScriptedBuilds::new(h.state.clone(), h.dir.path()));
    let server = crate::mcp::McpServer::default();
    let url = server.set_enabled(actions.clone(), 0, true, || async { Ok("tok-views".to_owned()) }).await.expect("start").url.expect("url");
    let reply = crate::mcp::tests::call_over_http(&url, "tok-views", "build", json!({ "kind": "part", "spec": clip(CLIP_SCRIPT) })).await;
    server.set_enabled(actions.clone(), 0, false, || async { Ok(String::new()) }).await.expect("stop");
    let content = reply["result"]["content"].as_array().expect("content").clone();
    assert_eq!(reply["result"]["isError"], false, "{reply}");

    let call = crate::tools::ToolCall {
        surface: Surface::InAppAgent,
        actions: actions.clone(),
        progress: Arc::new(|_| {}),
        cancel: CancellationToken::new(),
        blocking: TaskTracker::new(),
    };
    let in_app = Tool::Build.invoke(&call, json!({ "kind": "part", "spec": clip(CLIP_SCRIPT) })).await.expect("build");
    let output = super::tools::model_output(in_app).expect("output").into_content();

    assert_eq!(content.len(), output.len(), "{content:?}");
    let mcp_json: Value = serde_json::from_str(content[0]["text"].as_str().expect("text")).expect("json");
    let ToolResultContent::Json { value } = &output[0] else { panic!("json first: {:?}", output[0]) };
    for field in ["revision_id", "number", "build", "views", "checks_passed", "warnings", "requirements"] {
        assert_eq!(mcp_json[field], value[field], "{field}");
    }
    assert_eq!(mcp_json["views"], json!(["isometric", "front", "top"]));
    for (block, part) in content[1..].iter().zip(&output[1..]) {
        let ToolResultContent::Image(image) = part else { panic!("an image: {part:?}") };
        let DocumentSourceKind::Base64(data) = &image.data else { panic!("base64: {:?}", image.data) };
        assert_eq!((block["type"].as_str(), block["mimeType"].as_str()), (Some("image"), Some("image/png")));
        assert_eq!(block["data"].as_str(), Some(data.as_str()));
    }
}

// ─── Rig =0.42.0: view images inside tool results, on the wire ─────────────

/// A local stand-in for a provider: records each request body and refuses
/// the request, so nothing needs a key and nothing goes further.
async fn record_one_request(send: impl AsyncFnOnce(String)) -> Value {
    use axum::body::Bytes;
    let bodies = Arc::new(Mutex::new(Vec::<Bytes>::new()));
    let recorded = bodies.clone();
    let router = axum::Router::new().fallback(move |body: Bytes| {
        let recorded = recorded.clone();
        async move {
            recorded.lock().expect("bodies").push(body);
            (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": { "type": "invalid_request_error", "message": "recorded" } })))
        }
    });
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let url = format!("http://127.0.0.1:{}", listener.local_addr().expect("addr").port());
    let server = tokio::spawn(async move { axum::serve(listener, router).await });
    send(url).await;
    server.abort();
    let bodies = bodies.lock().expect("bodies");
    assert_eq!(bodies.len(), 1, "one request");
    serde_json::from_slice(&bodies[0]).expect("a JSON request body")
}

/// Polls a provider stream until it ends; the request goes out on the first poll.
async fn drain(stream: Result<rig::streaming::StreamingCompletionResponse, rig::completion::CompletionError>) {
    use futures::StreamExt;
    if let Ok(mut stream) = stream {
        while let Some(item) = stream.next().await {
            if item.is_err() {
                break;
            }
        }
    }
}

/// `value` with every string longer than 120 characters shortened, for printing.
fn shortened(value: &Value) -> Value {
    match value {
        Value::String(s) if s.chars().count() > 120 => json!(format!("{}... ({} chars)", s.chars().take(60).collect::<String>(), s.len())),
        Value::Array(items) => Value::Array(items.iter().map(shortened).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(k, v)| (k.clone(), shortened(v))).collect()),
        other => other.clone(),
    }
}

/// The question the design left open: does Rig `=0.42.0` carry images in
/// tool results to both providers? A scripted turn builds a part; the model
/// request that follows the build is replayed through the real Anthropic and
/// OpenAI (Responses API, the default `openai::Client`) clients against a
/// local recorder. Both serialized bodies carry the three PNG views inside
/// the tool result itself, in order, after the JSON summary.
#[tokio::test]
async fn rig_sends_the_view_images_inside_the_tool_result_to_anthropic_and_openai() {
    use rig::client::CompletionClient;
    use rig::completion::CompletionModel;
    use rig::providers::{anthropic, openai};

    let h = harness();
    let actions = Arc::new(ScriptedBuilds::new(h.state.clone(), h.dir.path()));
    let model = scripted(vec![
        tool_turn_as("toolu_build", "build", json!({ "kind": "part", "spec": clip(CLIP_SCRIPT) })),
        text_turn("Built."),
    ]);
    let turn = Turn::new(&h, "t1", actions.clone(), None);
    let events = turn.run("make the clip", Ok(ModelChoice::Scripted(model.clone()))).await;
    assert_framed(&events);
    let request = model.requests()[1].clone();
    let revision = results_of(&events, "build")[0]["revision_id"].as_str().expect("id").to_owned();
    let revision = actions.get(&revision).expect("revision");
    let views: Vec<String> =
        actions.views(&revision).views.iter().map(|(_, png)| crate::tools::base64(png)).collect();
    assert_eq!(views.len(), 3);

    let preamble = request.chat_history.iter().find_map(|m| match m {
        Message::System { content } => Some(content.clone()),
        _ => None,
    });
    let mut history: Vec<Message> = request.chat_history.iter().filter(|m| !matches!(m, Message::System { .. })).cloned().collect();
    let last = history.pop().expect("the tool result is the newest message");
    let replay = |model: anthropic::completion::CompletionModel| {
        let mut builder = model.completion_request(last.clone()).messages(history.clone()).max_tokens(8_192);
        if let Some(preamble) = preamble.clone().or(request.preamble.clone()) {
            builder = builder.preamble(preamble);
        }
        builder
    };

    let anthropic_body = record_one_request(async |url| {
        let client = anthropic::Client::builder().api_key("test-key").base_url(url).build().expect("client");
        drain(replay(client.completion_model(default_model(Provider::Anthropic))).stream().await).await;
    })
    .await;
    println!("anthropic request body: {}", serde_json::to_string_pretty(&shortened(&anthropic_body)).expect("json"));
    let tool_result = anthropic_body["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .flat_map(|m| m["content"].as_array().cloned().unwrap_or_default())
        .find(|c| c["type"] == "tool_result")
        .expect("a tool_result block");
    let parts = tool_result["content"].as_array().expect("tool_result content");
    assert_eq!(parts[0]["type"], "text");
    assert_eq!(serde_json::from_str::<Value>(parts[0]["text"].as_str().expect("text")).expect("json")["views"], json!(["isometric", "front", "top"]));
    let images: Vec<&Value> = parts[1..].iter().collect();
    assert_eq!(images.len(), 3, "{tool_result}");
    for (image, data) in images.iter().zip(&views) {
        assert_eq!(image["type"], "image");
        assert_eq!(image["source"], json!({ "type": "base64", "media_type": "image/png", "data": data }));
    }

    let openai_body = record_one_request(async |url| {
        let client = openai::Client::builder().api_key("test-key").base_url(format!("{url}/v1")).build().expect("client");
        let model = client.completion_model(default_model(Provider::Openai));
        let mut builder = model.completion_request(last.clone()).messages(history.clone());
        if let Some(preamble) = preamble.clone().or(request.preamble.clone()) {
            builder = builder.preamble(preamble);
        }
        drain(builder.stream().await).await;
    })
    .await;
    println!("openai request body: {}", serde_json::to_string_pretty(&shortened(&openai_body)).expect("json"));
    let output = openai_body["input"]
        .as_array()
        .expect("input")
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .expect("a function_call_output item")["output"]
        .as_array()
        .expect("rich output")
        .clone();
    assert_eq!(output[0]["type"], "input_text");
    assert_eq!(serde_json::from_str::<Value>(output[0]["text"].as_str().expect("text")).expect("json")["views"], json!(["isometric", "front", "top"]));
    assert_eq!(output.len(), 4, "{output:?}");
    for (image, data) in output[1..].iter().zip(&views) {
        assert_eq!(image["type"], "input_image");
        assert_eq!(image["image_url"], json!(format!("data:image/png;base64,{data}")));
    }
}
