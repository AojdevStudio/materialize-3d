//! The GUI, the in-app agent, and external MCP clients reach the same
//! `Actions`; each path fixes its own caller identity, and only the GUI path
//! can approve or record a print.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder};

use crate::actions::Actions;
use crate::fabrication::pipeline::Workspace;
use crate::fabrication::kind::KindId;
use crate::fabrication::revisions::{
    self, Actor, Approval, BuildFiles, Claim, NewRevision, PrintValidation, Revision, Sha256Hex, SlicerIdentity,
};
use crate::fabrication::{bambu, checks};
use crate::state::AppState;

struct Gui {
    _app: tauri::App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    actions: Actions,
    state: Arc<AppState>,
}

fn gui(dir: &Path) -> Gui {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            crate::actions::gui::design_build,
            crate::actions::gui::design_approve,
            crate::actions::gui::design_export,
            crate::actions::gui::design_record_print,
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let state = Arc::new(AppState::default());
    *state.db.lock().expect("db") = Some(crate::database::init_db(&dir.join("t.db")).expect("db"));
    let events = crate::actions::gui::app_events(app.handle().clone());
    let actions = Actions::new(events, state.clone(), Workspace::new(&dir.join("data"), &dir.join("cache")));
    app.manage(actions.clone());
    app.manage(crate::actions::gui::GuiBuilds::default());
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");
    Gui { _app: app, webview, actions, state }
}

fn invoke(gui: &Gui, cmd: &str, body: Value) -> Result<Value, Value> {
    invoke_on(&gui.webview, cmd, body)
}

/// A GUI command as the window sends it, from any thread.
fn invoke_on(webview: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().expect("json response"))
}

/// A verified revision requested by the agent, written without Bambu Studio.
fn agent_built_revision(gui: &Gui, dir: &Path) -> Revision {
    let package = dir.join("sign.3mf");
    std::fs::write(&package, b"package bytes").expect("package");
    let key = Sha256Hex::of_bytes(b"agent build");
    crate::fabrication::pipeline::with_db(&gui.state, |conn| {
        let request = NewRevision {
            lineage_id: None,
            kind: KindId::new("sign"),
            title: "Agent sign".into(),
            spec: json!({}),
            spec_sha256: key.clone(),
            build_key: key,
            check_plan: checks::test_support::PLAN,
            requested_by: Actor::Agent,
        };
        let Claim::Started(revision) = revisions::claim(conn, &request)? else {
            unreachable!("fresh database")
        };
        let files = BuildFiles {
            revision_dir: dir.to_path_buf(),
            package_sha256: Sha256Hex::of_file(&package)?,
            package_path: package.clone(),
            preview_path: dir.join("preview.png"),
            slice_dir: dir.join("slice"),
            gcode_sha256: Sha256Hex::of_bytes(b"gcode"),
            slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "02.08.00.05".into() },
            effective_settings: json!({}),
            size_mm: None,
        };
        let proof = checks::test_support::passed(&[checks::slice_check_id(bambu::CheckId::SliceSucceeded)]);
        revisions::finish_verified(conn, &revision.build_id, files, &proof)?;
        revisions::get(conn, &revision.id)
    })
    .expect("agent-built revision")
}

#[test]
fn a_person_approves_and_records_a_print_through_the_gui_commands() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());
    let revision = agent_built_revision(&gui, dir.path());
    let hash = revision.artifacts().expect("artifacts").files().package_sha256.to_string();

    let approved = invoke(&gui, "design_approve", json!({ "id": revision.id.as_str(), "packageSha256": hash, "acknowledgedWarnings": [] }))
        .expect("approve");
    assert_eq!(approved["approval"]["status"], "approved");
    assert_eq!(approved["approval"]["package_sha256"], hash.as_str());
    assert_eq!(approved["requested_by"], "agent", "approval does not rewrite who asked for the build");

    let printed = invoke(&gui, "design_record_print", json!({ "id": revision.id.as_str(), "passed": true, "note": "reads well" }))
        .expect("record print");
    assert_eq!(printed["print_validation"]["status"], "passed");
    let stored = gui.actions.get(revision.id.as_str()).expect("stored");
    assert!(matches!(stored.approval, Approval::Approved { .. }));
    assert!(matches!(stored.print_validation, PrintValidation::Passed { .. }));
}

#[test]
fn the_gui_approves_only_the_hash_it_was_shown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());
    let revision = agent_built_revision(&gui, dir.path());
    let other = Sha256Hex::of_bytes(b"a different package").to_string();
    let refused = invoke(&gui, "design_approve", json!({ "id": revision.id.as_str(), "packageSha256": other, "acknowledgedWarnings": [] }));
    assert!(refused.is_err(), "{refused:?}");
    assert!(matches!(gui.actions.get(revision.id.as_str()).expect("stored").approval, Approval::Pending));
}

fn spec_titled(title: &str) -> Value {
    let mut spec: Value = serde_json::from_str(include_str!("../tests/fixtures/signs/synthetic-back-shortly.json")).expect("fixture");
    spec["title"] = json!(title);
    spec
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
async fn each_caller_records_its_own_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());

    let gui_body = json!({ "kind": "sign", "spec": spec_titled("From the GUI"), "lineageId": null, "buildId": "b1", "onProgress": "__CHANNEL__:1" });
    let webview = gui.webview.clone();
    let from_gui = tokio::task::spawn_blocking(move || {
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "design_build".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().expect("url"),
                body: InvokeBody::Json(gui_body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().expect("json"))
    })
    .await
    .expect("join")
    .expect("gui build");
    assert_eq!(from_gui["revision"]["requested_by"], "human");

    let scope = crate::agent::tools::TurnScope {
        conversation_id: "c".into(),
        turn_id: "t".into(),
        state: gui.state.clone(),
        actions: Arc::new(gui.actions.clone()),
        emit: Arc::new(|_| {}),
        cancel: tokio_util::sync::CancellationToken::new(),
        blocking: tokio_util::task::TaskTracker::new(),
    };
    let from_agent = scope
        .invoke(crate::tools::Tool::Build, "call-1".into(), json!({ "kind": "sign", "spec": spec_titled("From the agent") }))
        .await
        .expect("agent build")
        .value;
    assert_eq!(from_agent["requested_by"], "agent");

    let server = crate::mcp::McpServer::default();
    let url = server
        .set_enabled(Arc::new(gui.actions.clone()), 0, true, || async { Ok("identity-token".to_owned()) })
        .await
        .expect("mcp")
        .url
        .expect("url");
    let call = |session: Option<String>, body: Value| {
        let mut request = reqwest::Client::new()
            .post(&url)
            .header("Authorization", "Bearer identity-token")
            .header("Accept", "application/json, text/event-stream")
            .json(&body);
        if let Some(id) = session {
            request = request.header("Mcp-Session-Id", id);
        }
        request.send()
    };
    let init = call(None, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}))
        .await
        .expect("initialize");
    let session = init.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_owned);
    call(session.clone(), json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.expect("initialized");
    let text = call(session, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"build","arguments":{"kind": "sign", "spec": spec_titled("From MCP")}}}))
        .await
        .expect("call")
        .text()
        .await
        .expect("body");
    let data = text.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim).find(|l| !l.is_empty()).unwrap_or(&text);
    let response: Value = serde_json::from_str(data).expect("json-rpc");
    let output: Value = serde_json::from_str(response["result"]["content"][0]["text"].as_str().expect("tool text")).expect("output");
    assert_eq!(output["requested_by"], "external_mcp");
    server.set_enabled(Arc::new(gui.actions.clone()), 0, false, || async { Ok(String::new()) }).await.expect("stop");

    let recorded: Vec<(String, Actor)> =
        gui.actions.list(10).expect("list").into_iter().map(|r| (r.title, r.requested_by)).collect();
    assert_eq!(recorded.len(), 3);
    for (title, actor) in [("From the GUI", Actor::Human), ("From the agent", Actor::Agent), ("From MCP", Actor::ExternalMcp)] {
        assert!(recorded.contains(&(title.to_owned(), actor)), "{title} recorded as {actor:?}: {recorded:?}");
    }
}

/// An MCP endpoint over `gui`'s actions, and its URL.
async fn mcp_over(gui: &Gui, token: &'static str) -> (crate::mcp::McpServer, String) {
    let server = crate::mcp::McpServer::default();
    let url = server
        .set_enabled(Arc::new(gui.actions.clone()), 0, true, move || async move { Ok(token.to_owned()) })
        .await
        .expect("mcp")
        .url
        .expect("url");
    (server, url)
}

/// The JSON a tool call over MCP returned.
fn tool_output(reply: &Value) -> Value {
    assert_eq!(reply["result"]["isError"], false, "{reply}");
    serde_json::from_str(reply["result"]["content"][0]["text"].as_str().expect("tool text")).expect("tool json")
}

/// A person approves and exports through the GUI commands; `get` over MCP
/// then names what they exported, where, and its hash.
#[tokio::test(flavor = "multi_thread")]
async fn get_over_mcp_returns_the_exports_a_person_made() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());
    let revision = agent_built_revision(&gui, dir.path());
    let id = revision.id.to_string();
    let hash = revision.artifacts().expect("artifacts").files().package_sha256.to_string();
    let (server, url) = mcp_over(&gui, "tok-exports").await;

    let before = tool_output(&crate::mcp::tests::call_over_http(&url, "tok-exports", "get", json!({ "revision_id": id })).await);
    assert_eq!((before["approval"].as_str(), &before["exports"]), (Some("pending"), &json!([])));

    let destination = dir.path().join("Fusion").join("inbox").join("clip-r1.3mf");
    let written = tokio::task::block_in_place(|| {
        invoke(&gui, "design_approve", json!({ "id": id, "packageSha256": hash, "acknowledgedWarnings": [] })).expect("approve");
        invoke(&gui, "design_export", json!({ "id": id, "format": "print_package", "destination": destination.display().to_string() }))
            .expect("export")
    });
    assert_eq!(written, json!(destination.display().to_string()));

    let after = tool_output(&crate::mcp::tests::call_over_http(&url, "tok-exports", "get", json!({ "revision_id": id })).await);
    assert_eq!(after["approval"], "approved");
    let exports = after["exports"].as_array().expect("exports");
    assert_eq!(exports.len(), 1, "{after}");
    assert_eq!(exports[0]["format"], "print_package");
    assert_eq!(exports[0]["path"], json!(destination.display().to_string()));
    assert_eq!(exports[0]["sha256"], json!(hash), "the bytes written are the approved package");
    assert!(exports[0]["exported_at"].is_string());
    server.set_enabled(Arc::new(gui.actions.clone()), 0, false, || async { Ok(String::new()) }).await.expect("stop");
}

/// A `get` with `wait_s` waits while approval is pending, other MCP calls
/// run meanwhile, and it returns as soon as a person approves from another
/// thread.
#[tokio::test(flavor = "multi_thread")]
async fn a_waiting_get_returns_when_a_person_approves_and_does_not_block_other_calls() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());
    let revision = agent_built_revision(&gui, dir.path());
    let id = revision.id.to_string();
    let hash = revision.artifacts().expect("artifacts").files().package_sha256.to_string();
    let (server, url) = mcp_over(&gui, "tok-wait").await;

    let started = std::time::Instant::now();
    let waiting = tokio::spawn({
        let (url, id) = (url.clone(), id.clone());
        async move { crate::mcp::tests::call_over_http(&url, "tok-wait", "get", json!({ "revision_id": id, "wait_s": 120 })).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(!waiting.is_finished(), "get waits while approval is pending");
    let listed = tool_output(&crate::mcp::tests::call_over_http(&url, "tok-wait", "list", json!({})).await);
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    assert!(!waiting.is_finished(), "list returned while get waits");

    let webview = gui.webview.clone();
    let approver = std::thread::spawn(move || {
        invoke_on(&webview, "design_approve", json!({ "id": id, "packageSha256": hash, "acknowledgedWarnings": [] })).map(drop)
    });
    approver.join().expect("approver thread").expect("approve");
    let approved_at = std::time::Instant::now();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(10), waiting).await.expect("woke").expect("join");
    let output = tool_output(&reply);
    assert_eq!(output["approval"], "approved", "{output}");
    assert!(approved_at.elapsed() < std::time::Duration::from_secs(2), "woken by the approval, {:?} after it", approved_at.elapsed());
    assert!(started.elapsed() < std::time::Duration::from_secs(60), "{:?}", started.elapsed());
    server.set_enabled(Arc::new(gui.actions.clone()), 0, false, || async { Ok(String::new()) }).await.expect("stop");
}

/// When nobody decides, a waiting `get` returns the revision, still pending,
/// once `wait_s` runs out; other MCP calls run meanwhile.
#[tokio::test(flavor = "multi_thread")]
async fn a_waiting_get_returns_at_the_timeout_with_approval_still_pending() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());
    let id = agent_built_revision(&gui, dir.path()).id.to_string();
    let (server, url) = mcp_over(&gui, "tok-timeout").await;

    let started = std::time::Instant::now();
    let waiting = tokio::spawn({
        let (url, id) = (url.clone(), id.clone());
        async move { crate::mcp::tests::call_over_http(&url, "tok-timeout", "get", json!({ "revision_id": id, "wait_s": 2 })).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let listed = tool_output(&crate::mcp::tests::call_over_http(&url, "tok-timeout", "list", json!({})).await);
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    assert!(!waiting.is_finished(), "list returned while get waits");

    let output = tool_output(&tokio::time::timeout(std::time::Duration::from_secs(10), waiting).await.expect("ended").expect("join"));
    let waited = started.elapsed();
    assert_eq!((output["revision_id"].as_str(), output["approval"].as_str()), (Some(id.as_str()), Some("pending")));
    assert!(waited >= std::time::Duration::from_secs(2) && waited < std::time::Duration::from_secs(8), "{waited:?}");
    server.set_enabled(Arc::new(gui.actions.clone()), 0, false, || async { Ok(String::new()) }).await.expect("stop");
}
