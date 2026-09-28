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
use crate::fabrication::build::Workspace;
use crate::fabrication::revisions::{
    self, Actor, Approval, Artifacts, BuildClaim, NewBuild, PrintValidation, RecordedCheck, Sha256Hex, SignRevision,
    SlicerIdentity,
};
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
            crate::sign_commands::sign_build,
            crate::sign_commands::sign_approve,
            crate::sign_commands::sign_record_print,
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let state = Arc::new(AppState::default());
    *state.db.lock().expect("db") = Some(crate::database::init_db(&dir.join("t.db")).expect("db"));
    let actions = Actions::new(app.handle().clone(), state.clone(), Workspace::new(&dir.join("data"), &dir.join("cache")));
    app.manage(actions.clone());
    app.manage(crate::sign_commands::GuiBuilds::default());
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default()).build().expect("webview");
    Gui { _app: app, webview, actions, state }
}

fn invoke(gui: &Gui, cmd: &str, body: Value) -> Result<Value, Value> {
    get_ipc_response(
        &gui.webview,
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
fn agent_built_revision(gui: &Gui, dir: &Path) -> SignRevision {
    let package = dir.join("sign.3mf");
    std::fs::write(&package, b"package bytes").expect("package");
    let key = Sha256Hex::of_bytes(b"agent build");
    crate::fabrication::build::with_db(&gui.state, |conn| {
        let BuildClaim::Started(revision) = revisions::claim_build(
            conn,
            NewBuild {
                lineage_id: None,
                title: "Agent sign".into(),
                spec: json!({}),
                spec_sha256: key.clone(),
                build_key: key,
                requested_by: Actor::Agent,
            },
        )?
        else {
            unreachable!("fresh database")
        };
        revisions::finish_build(
            conn,
            &revision.id,
            Artifacts {
                revision_dir: dir.to_path_buf(),
                package_sha256: Sha256Hex::of_file(&package)?,
                package_path: package.clone(),
                preview_path: dir.join("preview.png"),
                slice_dir: dir.join("slice"),
                gcode_sha256: Sha256Hex::of_bytes(b"gcode"),
                slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "02.08.00.05".into() },
                effective_settings: json!({}),
                checks: vec![RecordedCheck { id: "slice.slice_succeeded".into(), passed: true, detail: String::new() }],
            },
        )
    })
    .expect("agent-built revision")
}

#[test]
fn a_person_approves_and_records_a_print_through_the_gui_commands() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());
    let revision = agent_built_revision(&gui, dir.path());
    let hash = revision.artifacts().expect("artifacts").package_sha256.to_string();

    let approved = invoke(&gui, "sign_approve", json!({ "id": revision.id.as_str(), "packageSha256": hash })).expect("approve");
    assert_eq!(approved["approval"]["status"], "approved");
    assert_eq!(approved["approval"]["package_sha256"], hash.as_str());
    assert_eq!(approved["requested_by"], "agent", "approval does not rewrite who asked for the build");

    let printed = invoke(&gui, "sign_record_print", json!({ "id": revision.id.as_str(), "passed": true, "note": "reads well" }))
        .expect("record print");
    assert_eq!(printed["print_validation"]["status"], "passed");
    let stored = gui.actions.get_sign(revision.id.as_str()).expect("stored");
    assert!(matches!(stored.approval, Approval::Approved { .. }));
    assert!(matches!(stored.print_validation, PrintValidation::Passed { .. }));
}

#[test]
fn the_gui_approves_only_the_hash_it_was_shown() {
    let dir = tempfile::tempdir().expect("tempdir");
    let gui = gui(dir.path());
    let revision = agent_built_revision(&gui, dir.path());
    let other = Sha256Hex::of_bytes(b"a different package").to_string();
    let refused = invoke(&gui, "sign_approve", json!({ "id": revision.id.as_str(), "packageSha256": other }));
    assert!(refused.is_err(), "{refused:?}");
    assert!(matches!(gui.actions.get_sign(revision.id.as_str()).expect("stored").approval, Approval::Pending));
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

    let gui_body = json!({ "spec": spec_titled("From the GUI"), "lineageId": null, "buildId": "b1", "onProgress": "__CHANNEL__:1" });
    let webview = gui.webview.clone();
    let from_gui = tokio::task::spawn_blocking(move || {
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: "sign_build".into(),
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
    let from_agent = crate::agent::tools::AgentTool::BuildSign
        .run(&scope, "call-1".into(), json!({ "spec": spec_titled("From the agent") }))
        .await
        .expect("agent build");
    assert_eq!(from_agent["requested_by"], "agent");

    let server = crate::mcp::McpServer::default();
    let url = server
        .set_enabled(gui.actions.clone(), 0, true, || async { Ok("identity-token".to_owned()) })
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
    let text = call(session, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"build_sign","arguments":{"spec": spec_titled("From MCP")}}}))
        .await
        .expect("call")
        .text()
        .await
        .expect("body");
    let data = text.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim).find(|l| !l.is_empty()).unwrap_or(&text);
    let response: Value = serde_json::from_str(data).expect("json-rpc");
    let output: Value = serde_json::from_str(response["result"]["content"][0]["text"].as_str().expect("tool text")).expect("output");
    assert_eq!(output["revision"]["requested_by"], "external_mcp");
    server.set_enabled(gui.actions.clone(), 0, false, || async { Ok(String::new()) }).await.expect("stop");

    let recorded: Vec<(String, Actor)> =
        gui.actions.list_signs(10).expect("list").into_iter().map(|r| (r.title, r.requested_by)).collect();
    assert_eq!(recorded.len(), 3);
    for (title, actor) in [("From the GUI", Actor::Human), ("From the agent", Actor::Agent), ("From MCP", Actor::ExternalMcp)] {
        assert!(recorded.contains(&(title.to_owned(), actor)), "{title} recorded as {actor:?}: {recorded:?}");
    }
}
