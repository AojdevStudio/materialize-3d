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

use super::commands::{choose_model, default_model};
use super::protocol::{AgentErrorKind, AgentEvent, HistoryEntry, Provider, ToolCallStatus};
use super::store;
use super::tools::TurnScope;
use super::turn::{run_turn, ModelChoice, TurnEnd};
use crate::actions::{ActionError, RequestActions, RequestActor};
use crate::fabrication::build::{self, BuildError, BuildOutcome, BuildRequest, BuildStep, Workspace};
use crate::fabrication::revisions::{self, BuildState, LineageId, RevisionId, SignRevision};
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

/// No signs; `build_sign` reports its first step and then blocks until the
/// turn is cancelled, like a long slice.
#[derive(Default)]
struct FakeActions {
    build_exited: AtomicBool,
}

impl RequestActions for FakeActions {
    fn build_sign(
        &self,
        _spec: Value,
        _lineage_id: Option<&str>,
        _requester: RequestActor,
        progress: &dyn Fn(BuildStep),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<BuildOutcome, ActionError> {
        progress(BuildStep::SpecValidated);
        while !is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(50));
        self.build_exited.store(true, Ordering::SeqCst);
        Err(ActionError::Build(BuildError::Cancelled))
    }

    fn list_signs(&self, _limit: u32) -> Result<Vec<SignRevision>, ActionError> {
        Ok(Vec::new())
    }

    fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError> {
        Err(ActionError::State(format!("no sign {id}")))
    }

    fn show_sign(&self, _id: &str) -> Result<(), ActionError> {
        Ok(())
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Ok(PrinterState::default())
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
    fn build_sign(
        &self,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        progress: &dyn Fn(BuildStep),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<BuildOutcome, ActionError> {
        let lineage_id = lineage_id.map(LineageId::parse).transpose()?;
        let actor = requester.into();
        Ok(build::build_sign(&self.state, &self.workspace, BuildRequest { spec, lineage_id, actor }, progress, is_cancelled)?)
    }

    fn list_signs(&self, limit: u32) -> Result<Vec<SignRevision>, ActionError> {
        Ok(build::with_db(&self.state, |conn| revisions::list_recent(conn, limit))?)
    }

    fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(build::with_db(&self.state, |conn| revisions::check_integrity(conn, &id))?)
    }

    fn show_sign(&self, id: &str) -> Result<(), ActionError> {
        RevisionId::parse(id)?;
        Ok(())
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Ok(PrinterState::default())
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
    let model = scripted(vec![tool_turn("list_signs", json!({ "limit": 5 })), text_turn("No signs yet.")]);
    let events = turn.run("what signs exist?", Ok(ModelChoice::Scripted(model))).await;

    assert_framed(&events);
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["turnStarted", "toolCall", "toolResult", "textDelta", "turnFinished"]
    );
    let call_id = tool_call_id(&events, "list_signs");
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
    for said in ["hello", "Hi.", "what signs exist?", "list_signs", "No signs yet.", "and now?"] {
        assert!(seen.contains(said), "next turn's model input lacks {said:?}: {seen}");
    }
}

#[tokio::test]
async fn a_bad_tool_argument_goes_back_as_a_failed_result_without_ending_the_turn() {
    let h = harness();
    let turn = Turn::new(&h, "t1", Arc::new(FakeActions::default()), None);
    let model = scripted(vec![tool_turn("get_sign", json!({ "id": "x" })), text_turn("Sorry.")]);
    let events = turn.run("show sign x", Ok(ModelChoice::Scripted(model))).await;

    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::TurnFinished)));
    let call_id = tool_call_id(&events, "get_sign");
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

#[tokio::test]
async fn cancel_mid_build_sign_waits_for_the_build_and_marks_the_call_cancelled() {
    let h = harness();
    let actions = Arc::new(FakeActions::default());
    let turn = Turn::new(&h, "t1", actions.clone(), Some(BuildStep::SpecValidated));
    let spec: Value = serde_json::from_str(FIXTURE).expect("fixture");
    let model = scripted(vec![tool_turn("build_sign", json!({ "spec": spec })), text_turn("Built it.")]);
    let events = turn.run("make the sign", Ok(ModelChoice::Scripted(model))).await;

    assert_framed(&events);
    assert!(actions.build_exited.load(Ordering::SeqCst), "the blocking build ended before the turn reported");
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["turnStarted", "toolCall", "toolProgress", "toolResult", "turnCancelled"]
    );
    let call_id = tool_call_id(&events, "build_sign");
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
    let build_turn = || scripted(vec![tool_turn("build_sign", json!({ "spec": spec })), text_turn("Done.")]);

    let cancelled = Turn::new(&h, "t1", actions.clone(), Some(BuildStep::GeometryBuilt));
    let events = cancelled.run("make the sign", Ok(ModelChoice::Scripted(build_turn()))).await;
    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::TurnCancelled)));
    assert_eq!(call_status(&h, &tool_call_id(&events, "build_sign")), "cancelled");
    let listed = actions.list_signs(10).expect("list");
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
    assert_eq!(actions.list_signs(10).expect("list").len(), 2, "one cancelled and one verified revision, no duplicate");
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

#[tokio::test]
#[ignore = "live: needs OPENAI_API_KEY and a validated Bambu Studio"]
async fn live_openai_turn_builds_a_verified_sign() {
    let api_key = std::env::var("OPENAI_API_KEY").expect("OPENAI_API_KEY");
    let h = harness();
    let actions: Arc<dyn RequestActions> = Arc::new(PipelineActions::new(&h));
    let turn = Turn::new(&h, "live-1", actions, None);
    let model = default_model(Provider::Openai);
    println!("model: openai:{model}");
    let events = turn
        .run(
            "Make a 150 x 210 mm door sign that says BACK SHORTLY in navy on white with a teal rule under it",
            choose_model(Provider::Openai, model.into(), Some(api_key)),
        )
        .await;
    print_sequence(&events);

    assert_framed(&events);
    assert!(matches!(events.last(), Some(AgentEvent::TurnFinished)), "{:?}", events.last());
    tool_call_id(&events, "build_sign");
    let steps: Vec<BuildStep> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::ToolProgress { step, .. } => Some(*step),
            _ => None,
        })
        .collect();
    assert!(steps.contains(&BuildStep::Sliced), "build progress reported: {steps:?}");
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::ToolResult { ok: true, output, .. } if output["build"] == "verified")),
        "a build_sign result carries a verified revision"
    );
}
