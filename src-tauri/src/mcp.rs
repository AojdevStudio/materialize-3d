//! Local MCP endpoint so external agents (Claude Code, Codex, Cursor) can call
//! the same [`Actions`] as the GUI and the in-app agent.
//!
//! Off by default. When enabled it binds 127.0.0.1 only and requires
//! `Authorization: Bearer <token>`; the token lives in the OS keyring. There is
//! no approve, export, or print-result tool: those stay with a person in the app.

use std::future::Future;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ServerHandler};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::actions::{Actions, SignSummary};
use crate::fabrication::revisions::Actor;

pub const DEFAULT_PORT: u16 = 45373;
const TOKEN_KEY: &str = "mcp:token";
pub const ENABLED_SETTING: &str = "mcp.enabled";

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BuildSignArgs {
    /// A Materialize 3D SignSpec (schema_version 1): width_mm, height_mm, base ink,
    /// one or two inks, and painted elements (text, rect, svg) in finished-face
    /// millimeters with the origin at the top-left and y pointing down.
    pub spec: serde_json::Value,
    /// Add the build as a new revision of this sign instead of starting a new sign.
    pub lineage_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListSignsArgs {
    /// Most recent first; defaults to 20.
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RevisionArgs {
    pub revision_id: String,
}

#[derive(Serialize)]
struct BuildSignOutput {
    revision: SignSummary,
    reused: bool,
    next_step: &'static str,
}

fn json_text(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| e.to_string())
}

#[derive(Clone)]
pub struct MaterializeMcp {
    actions: Actions,
}

#[tool_router]
impl MaterializeMcp {
    pub fn new(actions: Actions) -> Self {
        Self { actions }
    }

    #[tool(description = "Build, slice with Bambu Studio, and verify a face-down multicolor sign from a SignSpec. \
        The result is a revision awaiting a person's approval in the Materialize 3D Signs view; this tool cannot approve it. \
        An identical spec returns the existing revision.")]
    async fn build_sign(&self, Parameters(args): Parameters<BuildSignArgs>) -> Result<String, String> {
        let actions = self.actions.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            actions.build_sign(args.spec, args.lineage_id.as_deref(), Actor::ExternalMcp, &|_| {}, &|| false)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        json_text(&BuildSignOutput {
            revision: SignSummary::from(&outcome.revision),
            reused: outcome.reused,
            next_step: "A person must review and approve this revision in the Materialize 3D Signs view.",
        })
    }

    #[tool(description = "List recent sign revisions with build, approval, and print-test status.")]
    async fn list_signs(&self, Parameters(args): Parameters<ListSignsArgs>) -> Result<String, String> {
        let revisions = self.actions.list_signs(args.limit.unwrap_or(20)).map_err(|e| e.to_string())?;
        json_text(&revisions.iter().map(SignSummary::from).collect::<Vec<_>>())
    }

    #[tool(description = "Read one sign revision, including any failed verification checks.")]
    async fn get_sign(&self, Parameters(args): Parameters<RevisionArgs>) -> Result<String, String> {
        let revision = self.actions.get_sign(&args.revision_id).map_err(|e| e.to_string())?;
        json_text(&SignSummary::from(&revision))
    }

    #[tool(description = "Open a sign revision in the Materialize 3D Signs view for the person at the computer.")]
    async fn show_sign(&self, Parameters(args): Parameters<RevisionArgs>) -> Result<String, String> {
        self.actions.show_sign(&args.revision_id).map_err(|e| e.to_string())?;
        Ok("opened in the Signs view".into())
    }

    #[tool(description = "Read the connected printer's status: connection, temperatures, job state, and progress.")]
    async fn printer_status(&self) -> Result<String, String> {
        json_text(&self.actions.printer_status().map_err(|e| e.to_string())?)
    }
}

#[tool_handler]
impl ServerHandler for MaterializeMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("materialize-3d", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Materialize 3D designs and verifies multicolor signs for a Bambu P2S. \
                 Builds you request wait for a person's approval in the app."
                    .to_string(),
            )
    }
}

async fn require_bearer(State(token): State<Arc<str>>, req: Request, next: Next) -> Result<Response, StatusCode> {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if bool::from(presented.as_bytes().ct_eq(token.as_bytes())) && !token.is_empty() {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

struct Running {
    cancel: CancellationToken,
    task: JoinHandle<std::io::Result<()>>,
    port: u16,
}

/// Owns the endpoint's lifecycle. Enabling, disabling, and rotating take the
/// same lock and read or write the token while holding it, so the running
/// server always serves the token that is currently stored.
#[derive(Default)]
pub struct McpServer {
    running: Mutex<Option<Running>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub url: Option<String>,
}

impl McpServer {
    /// Turns the endpoint on (idempotent) or off. `token` is called only when
    /// the endpoint actually starts.
    pub async fn set_enabled<F, Fut>(&self, actions: Actions, port: u16, enabled: bool, token: F) -> Result<McpStatus, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        let mut running = self.running.lock().await;
        if !enabled {
            if let Some(current) = running.take() {
                shut_down(current).await;
            }
        } else if running.is_none() {
            *running = Some(serve(actions, port, token().await?).await.map_err(|e| e.to_string())?);
        }
        Ok(status_of(running.as_ref().map(|r| r.port)))
    }

    /// Stores a new token through `new_token` and, when the endpoint is running,
    /// restarts it on that token before returning, so the old token stops working.
    pub async fn rotate<F, Fut>(&self, actions: Actions, new_token: F) -> Result<String, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        let mut running = self.running.lock().await;
        let token = new_token().await?;
        if let Some(current) = running.take() {
            let port = current.port;
            shut_down(current).await;
            *running = Some(serve(actions, port, token.clone()).await.map_err(|e| e.to_string())?);
        }
        Ok(token)
    }

    pub async fn status(&self) -> McpStatus {
        status_of(self.running.lock().await.as_ref().map(|r| r.port))
    }
}

async fn serve(actions: Actions, port: u16, token: String) -> std::io::Result<Running> {
    let cancel = CancellationToken::new();
    let service = StreamableHttpService::new(
        move || Ok(MaterializeMcp::new(actions.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel.child_token()),
    );
    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(Arc::<str>::from(token), require_bearer));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let shutdown = cancel.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).with_graceful_shutdown(async move { shutdown.cancelled().await }).await
    });
    log::info!("mcp: listening on 127.0.0.1:{port}");
    Ok(Running { cancel, task, port })
}

async fn shut_down(running: Running) {
    running.cancel.cancel();
    if let Err(err) = running.task.await {
        log::warn!("mcp: server task ended abnormally: {err}");
    }
    log::info!("mcp: stopped");
}

fn status_of(port: Option<u16>) -> McpStatus {
    McpStatus { running: port.is_some(), url: port.map(|p| format!("http://127.0.0.1:{p}/mcp")) }
}

/// Returns the stored token, creating one on first use.
pub async fn token() -> Result<String, String> {
    if let Some(token) = crate::credentials::get_credential(TOKEN_KEY).await? {
        return Ok(token);
    }
    rotate_token().await
}

pub async fn rotate_token() -> Result<String, String> {
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    crate::credentials::store_credential(TOKEN_KEY, &token).await?;
    Ok(token)
}

fn setting_enabled(state: &crate::state::AppState) -> Result<bool, String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database is not initialized")?;
    Ok(crate::database::get_setting(conn, ENABLED_SETTING)?.as_deref() == Some("true"))
}

/// Starts the endpoint at launch only when the person turned it on earlier.
pub async fn start_if_enabled<F, Fut>(
    server: &McpServer,
    actions: Actions,
    state: &crate::state::AppState,
    token: F,
) -> Result<McpStatus, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    if setting_enabled(state)? {
        server.set_enabled(actions, DEFAULT_PORT, true, token).await
    } else {
        Ok(server.status().await)
    }
}

#[tauri::command]
pub async fn mcp_status(server: tauri::State<'_, McpServer>) -> Result<McpStatus, String> {
    Ok(server.status().await)
}

#[tauri::command]
pub async fn mcp_set_enabled(
    server: tauri::State<'_, McpServer>,
    actions: tauri::State<'_, Actions>,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    enabled: bool,
) -> Result<McpStatus, String> {
    {
        let guard = state.db.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("database is not initialized")?;
        crate::database::upsert_setting(conn, ENABLED_SETTING, if enabled { "true" } else { "false" })?;
    }
    server.set_enabled(actions.inner().clone(), DEFAULT_PORT, enabled, token).await
}

/// Reveals the token so a person can paste it into their agent's MCP config.
#[tauri::command]
pub async fn mcp_token() -> Result<String, String> {
    token().await
}

/// Issues a new token and restarts a running endpoint so the old one stops working.
#[tauri::command]
pub async fn mcp_rotate_token(server: tauri::State<'_, McpServer>, actions: tauri::State<'_, Actions>) -> Result<String, String> {
    server.rotate(actions.inner().clone(), rotate_token).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_names() -> Vec<String> {
        MaterializeMcp::tool_router().list_all().into_iter().map(|tool| tool.name.to_string()).collect()
    }

    #[test]
    fn exposes_the_shared_actions_and_no_approval_path() {
        let mut names = tool_names();
        names.sort();
        assert_eq!(names, ["build_sign", "get_sign", "list_signs", "printer_status", "show_sign"]);
        for forbidden in ["approve", "export", "print_result", "record_print"] {
            assert!(names.iter().all(|name| !name.contains(forbidden)), "{forbidden} must stay human-only");
        }
    }

    async fn serve_behind_bearer(token: &str) -> (u16, CancellationToken) {
        let cancel = CancellationToken::new();
        let router = axum::Router::new()
            .route("/mcp", axum::routing::post(|| async { "reached" }))
            .layer(middleware::from_fn_with_state(Arc::<str>::from(token), require_bearer));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let shutdown = cancel.clone();
        tokio::spawn(async move {
            axum::serve(listener, router).with_graceful_shutdown(async move { shutdown.cancelled().await }).await
        });
        (port, cancel)
    }

    #[tokio::test]
    async fn requests_without_the_exact_bearer_token_are_rejected() {
        let (port, cancel) = serve_behind_bearer("s3cret-token").await;
        let url = format!("http://127.0.0.1:{port}/mcp");
        let client = reqwest::Client::new();
        let status = |auth: Option<&'static str>| {
            let mut request = client.post(&url);
            if let Some(value) = auth {
                request = request.header("Authorization", value);
            }
            async move { request.send().await.expect("send").status().as_u16() }
        };
        assert_eq!(status(None).await, 401);
        assert_eq!(status(Some("Bearer wrong")).await, 401);
        assert_eq!(status(Some("Bearer s3cret-tok")).await, 401, "prefix of the token is rejected");
        assert_eq!(status(Some("s3cret-token")).await, 401, "missing Bearer scheme is rejected");
        assert_eq!(status(Some("Bearer s3cret-token")).await, 200);
        cancel.cancel();
    }

    fn sse_json(body: &str) -> serde_json::Value {
        let data = body
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or(body);
        serde_json::from_str(data).expect("json-rpc body")
    }

    /// Actions over a fresh database in `dir`, plus the app state behind them.
    pub(crate) fn test_actions(dir: &std::path::Path) -> (Actions, Arc<crate::state::AppState>) {
        let app = tauri::test::mock_app();
        let state = Arc::new(crate::state::AppState::default());
        *state.db.lock().expect("db") = Some(crate::database::init_db(&dir.join("t.db")).expect("db init"));
        let workspace = crate::fabrication::build::Workspace::new(&dir.join("data"), &dir.join("cache"));
        (Actions::new(app.handle().clone(), state.clone(), workspace), state)
    }

    async fn fixed(token: &str) -> Result<String, String> {
        Ok(token.to_owned())
    }

    fn initialize() -> serde_json::Value {
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}})
    }

    /// HTTP status of an MCP initialize request with this bearer token.
    async fn initialize_status(url: &str, token: &str) -> u16 {
        reqwest::Client::new()
            .post(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json, text/event-stream")
            .json(&initialize())
            .send()
            .await
            .expect("send")
            .status()
            .as_u16()
    }

    #[tokio::test]
    async fn the_endpoint_stays_off_until_the_person_turns_it_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, state) = test_actions(dir.path());
        let server = McpServer::default();
        let asked_for_token = std::sync::atomic::AtomicBool::new(false);
        let status = start_if_enabled(&server, actions, &state, || async {
            asked_for_token.store(true, std::sync::atomic::Ordering::SeqCst);
            fixed("unused").await
        })
        .await
        .expect("launch");
        assert!(!status.running, "no setting means no listener");
        assert!(!asked_for_token.load(std::sync::atomic::Ordering::SeqCst), "the keyring is not touched");
    }

    #[tokio::test]
    async fn it_listens_on_loopback_and_refuses_other_hosts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, _state) = test_actions(dir.path());
        let server = McpServer::default();
        let url = server.set_enabled(actions, 0, true, || fixed("tok-loop")).await.expect("start").url.expect("url");
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        let rebound = reqwest::Client::new()
            .post(&url)
            .header("Host", "attacker.example")
            .header("Authorization", "Bearer tok-loop")
            .header("Accept", "application/json, text/event-stream")
            .json(&initialize())
            .send()
            .await
            .expect("send");
        assert_ne!(rebound.status().as_u16(), 200, "a DNS-rebinding Host header is refused");
        assert_eq!(initialize_status(&url, "tok-loop").await, 200);
        server.set_enabled(test_actions(dir.path()).0, 0, false, || fixed("unused")).await.expect("stop");
    }

    #[tokio::test]
    async fn rotating_the_token_turns_the_old_one_away() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, _state) = test_actions(dir.path());
        let server = McpServer::default();
        let url = server.set_enabled(actions.clone(), 0, true, || fixed("old-token")).await.expect("start").url.expect("url");
        assert_eq!(initialize_status(&url, "old-token").await, 200);
        server.rotate(actions.clone(), || fixed("new-token")).await.expect("rotate");
        let url = server.status().await.url.expect("still running");
        assert_eq!(initialize_status(&url, "old-token").await, 401, "the old token stops working");
        assert_eq!(initialize_status(&url, "new-token").await, 200);
        server.set_enabled(actions, 0, false, || fixed("unused")).await.expect("stop");
    }

    #[tokio::test]
    async fn enabling_while_rotating_leaves_the_server_on_the_stored_token() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, _state) = test_actions(dir.path());
        for enable_first in [true, false] {
            let server = McpServer::default();
            let stored = std::sync::Mutex::new("old-token".to_owned());
            // Reads the token, then is slow to finish starting: the window in which
            // an unserialized rotation would store a new token behind its back.
            let enable = server.set_enabled(actions.clone(), 0, true, || async {
                let token = stored.lock().expect("stored").clone();
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                Ok(token)
            });
            let rotate = server.rotate(actions.clone(), || async {
                *stored.lock().expect("stored") = "new-token".to_owned();
                Ok("new-token".to_owned())
            });
            if enable_first {
                let (enabled, rotated) = tokio::join!(enable, async {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    rotate.await
                });
                enabled.expect("enable");
                rotated.expect("rotate");
            } else {
                let (rotated, enabled) = tokio::join!(rotate, async {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    enable.await
                });
                rotated.expect("rotate");
                enabled.expect("enable");
            }
            let url = server.status().await.url.expect("running");
            assert_eq!(initialize_status(&url, "new-token").await, 200, "enable_first={enable_first}");
            assert_eq!(initialize_status(&url, "old-token").await, 401, "enable_first={enable_first}");
            server.set_enabled(actions.clone(), 0, false, || fixed("unused")).await.expect("stop");
        }
    }

    #[tokio::test]
    async fn an_external_client_lists_and_calls_the_shared_tools_over_http() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, _state) = test_actions(dir.path());
        let server = McpServer::default();
        let status = server.set_enabled(actions.clone(), 0, true, || fixed("tok-123")).await.expect("start");
        let url = status.url.expect("url");
        let client = reqwest::Client::new();
        let rpc = |session: Option<String>, body: serde_json::Value| {
            let mut request = client
                .post(&url)
                .header("Authorization", "Bearer tok-123")
                .header("Accept", "application/json, text/event-stream")
                .json(&body);
            if let Some(id) = session {
                request = request.header("Mcp-Session-Id", id);
            }
            request.send()
        };

        let init = rpc(None, initialize())
            .await
            .expect("initialize");
        let session = init.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_owned);
        assert_eq!(sse_json(&init.text().await.expect("body"))["result"]["serverInfo"]["name"], "materialize-3d");
        rpc(session.clone(), serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.expect("initialized");

        let listed = sse_json(&rpc(session.clone(), serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .await.expect("list").text().await.expect("body"));
        let mut names: Vec<String> = listed["result"]["tools"].as_array().expect("tools").iter()
            .map(|t| t["name"].as_str().expect("name").to_owned()).collect();
        names.sort();
        assert_eq!(names, ["build_sign", "get_sign", "list_signs", "printer_status", "show_sign"]);

        let called = sse_json(&rpc(session.clone(), serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"list_signs","arguments":{}}})).await.expect("call").text().await.expect("body"));
        assert_eq!(called["result"]["isError"], false);
        assert_eq!(called["result"]["content"][0]["text"], "[]");

        let smuggled = sse_json(&rpc(session, serde_json::json!({"jsonrpc":"2.0","id":4,"method":"tools/call",
            "params":{"name":"build_sign","arguments":{"spec":{},"actor":"human","requested_by":"human"}}}))
            .await.expect("call").text().await.expect("body"));
        assert_eq!(smuggled["result"]["isError"], true, "an actor argument is rejected, not ignored: {smuggled}");
        let reason = smuggled["result"]["content"][0]["text"].as_str().unwrap_or_default();
        assert!(reason.contains("unknown field `actor`"), "{reason}");
        server.set_enabled(actions, 0, false, || fixed("unused")).await.expect("stop");
    }
}
