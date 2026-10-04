//! Local MCP endpoint so external agents (Claude Code, Codex, Cursor) can call
//! the registry's tools ([`crate::tools`]) over the same actions as the GUI
//! and the in-app agent, held only as a [`RequestActions`].
//!
//! Off by default. When enabled it binds 127.0.0.1 only and requires
//! `Authorization: Bearer <token>`; the token lives in the OS keyring. There is
//! no approve, export, or print-result tool: those stay with a person in the app.
//! `import_part` is offered here only, because it takes a path on this computer.

use std::future::Future;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ResultType, ServerCapabilities, ServerConfig,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde::Serialize;
use subtle::ConstantTimeEq;
use tokio::sync::{watch, Mutex};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::actions::RequestActions;
use crate::fabrication::kind::KindDriver;
use crate::tools::{self, Surface, Tool, ToolCall, ToolContent};

pub const DEFAULT_PORT: u16 = 45373;
const TOKEN_KEY: &str = "mcp:token";
pub const ENABLED_SETTING: &str = "mcp.enabled";

/// The MCP definition of a registry tool: its name, description, and schema
/// as declared once in [`Tool`], for the kinds the app can build now.
fn advertised(tool: Tool, kinds: &[&'static dyn KindDriver]) -> rmcp::model::Tool {
    let schema = tool.parameters(kinds).as_object().cloned().unwrap_or_default();
    rmcp::model::Tool::new(tool.name(), tool.description(), Arc::new(schema))
}

/// A tool's content as MCP content: the JSON as text, then each view as a PNG
/// image, the same content the in-app agent sends its model.
fn mcp_content(content: ToolContent) -> Result<Vec<ContentBlock>, serde_json::Error> {
    let text = ContentBlock::text(serde_json::to_string_pretty(&content.value)?);
    let images = content.views.iter().map(|(_, png)| ContentBlock::image(tools::base64(png), "image/png"));
    Ok(std::iter::once(text).chain(images).collect())
}

fn offered(name: &str) -> Option<Tool> {
    Tool::on(Surface::ExternalMcp).find(|tool| tool.name() == name)
}

#[derive(Clone)]
pub struct MaterializeMcp {
    actions: Arc<dyn RequestActions>,
    /// Runs each call's action work off the serve task, so a stall or panic in
    /// its database or hashing work stays inside that one tool call.
    blocking: TaskTracker,
}

impl MaterializeMcp {
    pub fn new(actions: Arc<dyn RequestActions>) -> Self {
        Self { actions, blocking: TaskTracker::new() }
    }

    /// The kinds the app can build now. The first call may verify the CAD
    /// runtime, so it runs on the blocking pool.
    async fn kinds(&self) -> Result<Vec<&'static dyn KindDriver>, ErrorData> {
        let actions = self.actions.clone();
        self.blocking
            .spawn_blocking(move || actions.kinds())
            .await
            .map_err(|e| ErrorData::internal_error(format!("listing the kinds failed: {e}"), None))
    }
}

impl ServerHandler for MaterializeMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("materialize-3d", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "Materialize 3D designs and verifies printable objects for a Bambu P2S; build takes a kind \
                 and that kind's spec, and describe_kind says how to write one. import_part brings in a mesh \
                 made in another program, such as Fusion, for the same checks. Builds you request wait for a \
                 person's approval in the app; get with wait_s waits for that decision."
                    .to_string(),
            )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        // The same cache hints rmcp's generated handler sends.
        let supports_cache_hints = context.protocol_version().is_some_and(|version| version >= ProtocolVersion::V_2026_07_28);
        let kinds = self.kinds().await?;
        Ok(ListToolsResult {
            result_type: Some(ResultType::COMPLETE),
            tools: Tool::on(Surface::ExternalMcp).map(|tool| advertised(tool, &kinds)).collect(),
            meta: None,
            next_cursor: None,
            ttl_ms: supports_cache_hints.then_some(0),
            cache_scope: supports_cache_hints.then_some(CacheScope::Public),
        })
    }

    /// Sync, so the kinds are read here directly. The CAD runtime is verified
    /// once per process, so only a first call can take long.
    fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
        offered(name).map(|tool| advertised(tool, &self.actions.kinds()))
    }

    /// An unlisted name is refused before anything runs; a tool's own failure
    /// (bad arguments included) comes back as an error result the agent reads.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let tool = offered(&request.name).ok_or_else(|| ErrorData::invalid_params("tool not found", None))?;
        let call = ToolCall {
            surface: Surface::ExternalMcp,
            actions: self.actions.clone(),
            progress: Arc::new(|_| {}),
            cancel: CancellationToken::new(),
            blocking: self.blocking.clone(),
        };
        let args = serde_json::Value::Object(request.arguments.unwrap_or_default());
        let result = match tool.invoke(&call, args).await {
            Ok(content) => match mcp_content(content) {
                Ok(content) => CallToolResult::success(content),
                Err(err) => CallToolResult::error(vec![ContentBlock::text(err.to_string())]),
            },
            Err(err) => CallToolResult::error(vec![ContentBlock::text(err.to_string())]),
        };
        Ok(result.into())
    }
}

async fn require_bearer(State(token): State<watch::Receiver<Arc<str>>>, req: Request, next: Next) -> Result<Response, StatusCode> {
    let token = token.borrow().clone();
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
    /// The token the bearer check accepts; replacing it takes effect on the next request.
    token: watch::Sender<Arc<str>>,
}

/// Owns the endpoint's lifecycle. Enabling, disabling, and rotating take the
/// same lock and read or write the token while holding it, so the running
/// server always serves the token that is currently stored. A server whose
/// task has ended is treated as off.
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
    pub async fn set_enabled<F, Fut>(
        &self,
        actions: Arc<dyn RequestActions>,
        port: u16,
        enabled: bool,
        token: F,
    ) -> Result<McpStatus, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        self.set_enabled_recording(actions, port, enabled, token, |_| Ok(())).await
    }

    /// [`Self::set_enabled`] that also hands the person's choice to `record`,
    /// under the same lock: before stopping, and only after a successful start,
    /// so a failed enable is never remembered as on.
    pub async fn set_enabled_recording<F, Fut>(
        &self,
        actions: Arc<dyn RequestActions>,
        port: u16,
        enabled: bool,
        token: F,
        record: impl FnOnce(bool) -> Result<(), String>,
    ) -> Result<McpStatus, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        let mut running = self.running.lock().await;
        reap(&mut running).await;
        if !enabled {
            record(false)?;
            if let Some(current) = running.take() {
                shut_down(current).await;
            }
        } else if running.is_none() {
            let started = serve(actions, port, token().await?).await.map_err(|e| e.to_string())?;
            if let Err(err) = record(true) {
                shut_down(started).await;
                return Err(err);
            }
            *running = Some(started);
        } else {
            record(true)?;
        }
        Ok(status_of(running.as_ref().map(|r| r.port)))
    }

    /// Stores a new token through `new_token` and, when the endpoint is running,
    /// switches it to that token before returning, so the old token stops working.
    /// The listener stays up throughout, and a failed store changes nothing.
    pub async fn rotate<F, Fut>(&self, new_token: F) -> Result<String, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        let mut running = self.running.lock().await;
        reap(&mut running).await;
        let token = new_token().await?;
        if let Some(current) = running.as_ref() {
            current.token.send_replace(Arc::from(token.as_str()));
        }
        Ok(token)
    }

    pub async fn status(&self) -> McpStatus {
        let mut running = self.running.lock().await;
        reap(&mut running).await;
        status_of(running.as_ref().map(|r| r.port))
    }
}

async fn serve(actions: Arc<dyn RequestActions>, port: u16, token: String) -> std::io::Result<Running> {
    let cancel = CancellationToken::new();
    let service = StreamableHttpService::new(
        move || Ok(MaterializeMcp::new(actions.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_cancellation_token(cancel.child_token()),
    );
    let (token, accepted) = watch::channel(Arc::<str>::from(token));
    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(accepted, require_bearer));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let shutdown = cancel.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).with_graceful_shutdown(async move { shutdown.cancelled().await }).await
    });
    log::info!("mcp: listening on 127.0.0.1:{port}");
    Ok(Running { cancel, task, port, token })
}

async fn shut_down(running: Running) {
    running.cancel.cancel();
    if let Err(err) = running.task.await {
        log::warn!("mcp: server task ended abnormally: {err}");
    }
    log::info!("mcp: stopped");
}

/// Drops the entry for a server whose task has already ended (a panic, or the
/// listener failing), so status reads as off and enabling starts a fresh one.
async fn reap(running: &mut Option<Running>) {
    let Some(dead) = running.take_if(|r| r.task.is_finished()) else { return };
    match dead.task.await {
        Ok(Ok(())) => log::warn!("mcp: server stopped on its own"),
        Ok(Err(err)) => log::error!("mcp: server failed: {err}"),
        Err(err) => log::error!("mcp: server task ended abnormally: {err}"),
    }
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

/// Remembers the person's choice so the next launch starts the endpoint only with consent.
fn record_enabled(state: &crate::state::AppState, enabled: bool) -> Result<(), String> {
    let guard = state.db.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("database is not initialized")?;
    crate::database::upsert_setting(conn, ENABLED_SETTING, if enabled { "true" } else { "false" })
}

/// Starts the endpoint at launch only when the person turned it on earlier.
pub async fn start_if_enabled<F, Fut>(
    server: &McpServer,
    actions: Arc<dyn RequestActions>,
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
    actions: tauri::State<'_, Arc<dyn RequestActions>>,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    enabled: bool,
) -> Result<McpStatus, String> {
    server.set_enabled_recording(actions.inner().clone(), DEFAULT_PORT, enabled, token, |on| record_enabled(&state, on)).await
}

/// Reveals the token so a person can paste it into their agent's MCP config.
#[tauri::command]
pub async fn mcp_token() -> Result<String, String> {
    token().await
}

/// Issues a new token and switches a running endpoint to it so the old one stops working.
#[tauri::command]
pub async fn mcp_rotate_token(server: tauri::State<'_, McpServer>) -> Result<String, String> {
    server.rotate(rotate_token).await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn tool_names() -> Vec<String> {
        Tool::on(Surface::ExternalMcp).map(|tool| advertised(tool, crate::fabrication::kind::KINDS)).map(|tool| tool.name.to_string()).collect()
    }

    #[test]
    fn exposes_the_shared_actions_and_no_approval_path() {
        let mut names = tool_names();
        names.sort();
        assert_eq!(names, ["build", "describe_kind", "get", "import_part", "list", "printer_status", "revise", "show"]);
        for forbidden in ["approve", "export", "print_result", "record_print"] {
            assert!(names.iter().all(|name| !name.contains(forbidden)), "{forbidden} must stay human-only");
        }
    }

    async fn serve_behind_bearer(token: &str) -> (u16, CancellationToken) {
        let cancel = CancellationToken::new();
        let router = axum::Router::new()
            .route("/mcp", axum::routing::post(|| async { "reached" }))
            .layer(middleware::from_fn_with_state(watch::channel(Arc::<str>::from(token)).1, require_bearer));
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
    pub(crate) fn test_actions(dir: &std::path::Path) -> (Arc<dyn RequestActions>, Arc<crate::state::AppState>) {
        let state = Arc::new(crate::state::AppState::default());
        *state.db.lock().expect("db") = Some(crate::database::init_db(&dir.join("t.db")).expect("db init"));
        let workspace = crate::fabrication::pipeline::Workspace::new(&dir.join("data"), &dir.join("cache"));
        let actions = crate::actions::Actions::new(Arc::new(|_, _| {}), state.clone(), workspace);
        (Arc::new(actions), state)
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
        server.rotate(|| fixed("new-token")).await.expect("rotate");
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
            let rotate = server.rotate(|| async {
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
        assert_eq!(names, ["build", "describe_kind", "get", "import_part", "list", "printer_status", "revise", "show"]);

        let called = sse_json(&rpc(session.clone(), serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"list","arguments":{}}})).await.expect("call").text().await.expect("body"));
        assert_eq!(called["result"]["isError"], false);
        assert_eq!(called["result"]["content"][0]["text"], "[]");

        let smuggled = sse_json(&rpc(session, serde_json::json!({"jsonrpc":"2.0","id":4,"method":"tools/call",
            "params":{"name":"build","arguments":{"kind":"sign","spec":{},"actor":"human","requested_by":"human"}}}))
            .await.expect("call").text().await.expect("body"));
        assert_eq!(smuggled["result"]["isError"], true, "an actor argument is rejected, not ignored: {smuggled}");
        let reason = smuggled["result"]["content"][0]["text"].as_str().unwrap_or_default();
        assert!(reason.contains("unknown field `actor`"), "{reason}");
        server.set_enabled(actions, 0, false, || fixed("unused")).await.expect("stop");
    }

    /// Calls `name` with `arguments` over HTTP in a fresh session; returns the JSON-RPC reply.
    pub(crate) async fn call_over_http(url: &str, token: &str, name: &str, arguments: serde_json::Value) -> serde_json::Value {
        let client = reqwest::Client::new();
        let rpc = |session: Option<String>, body: serde_json::Value| {
            let mut request = client
                .post(url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/json, text/event-stream")
                .json(&body);
            if let Some(id) = session {
                request = request.header("Mcp-Session-Id", id);
            }
            request.send()
        };
        let init = rpc(None, initialize()).await.expect("initialize");
        let session = init.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_owned);
        rpc(session.clone(), serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.expect("initialized");
        sse_json(&rpc(session, serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":name,"arguments":arguments}})).await.expect("call").text().await.expect("body"))
    }

    /// Lists the tools over HTTP, then calls `name`; returns the listed tools and the call's JSON-RPC reply.
    async fn list_then_call(url: &str, token: &str, name: &str) -> (Vec<serde_json::Value>, serde_json::Value) {
        let client = reqwest::Client::new();
        let rpc = |session: Option<String>, body: serde_json::Value| {
            let mut request = client
                .post(url)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", "application/json, text/event-stream")
                .json(&body);
            if let Some(id) = session {
                request = request.header("Mcp-Session-Id", id);
            }
            request.send()
        };
        let init = rpc(None, initialize()).await.expect("initialize");
        let session = init.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(str::to_owned);
        rpc(session.clone(), serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})).await.expect("initialized");
        let listed = sse_json(&rpc(session.clone(), serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .await.expect("list").text().await.expect("body"));
        let called = sse_json(&rpc(session, serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":name,"arguments":{}}})).await.expect("call").text().await.expect("body"));
        (listed["result"]["tools"].as_array().expect("tools").clone(), called)
    }

    /// Checked for an app without the CAD runtime (signs only) and for one
    /// with it (`part` offered too).
    #[tokio::test]
    async fn the_agent_and_mcp_advertise_identical_definitions_for_every_shared_tool() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (signs_only, state) = test_actions(dir.path());
        let with_part: Arc<dyn RequestActions> = Arc::new(crate::agent::tests::ScriptedBuilds::new(state.clone(), dir.path()));
        for (actions, kinds) in [(signs_only, serde_json::json!(["sign"])), (with_part, serde_json::json!(["sign", "part"]))] {
            let server = McpServer::default();
            let url = server.set_enabled(actions.clone(), 0, true, || fixed("tok-same")).await.expect("start").url.expect("url");
            let (listed, _) = list_then_call(&url, "tok-same", "list").await;
            server.set_enabled(actions.clone(), 0, false, || fixed("unused")).await.expect("stop");

            let scope = Arc::new(crate::agent::tools::TurnScope {
                conversation_id: "c".into(),
                turn_id: "t".into(),
                state: state.clone(),
                actions,
                emit: Arc::new(|_| {}),
                cancel: CancellationToken::new(),
                blocking: TaskTracker::new(),
            });
            let agent: Vec<_> =
                crate::agent::tools::bind_all(&scope, &scope.actions.kinds()).iter().map(|tool| tool.definition()).collect();
            let shared: Vec<Tool> =
                Tool::on(Surface::InAppAgent).filter(|tool| Tool::on(Surface::ExternalMcp).any(|t| t == *tool)).collect();
            assert_eq!(shared.len(), Tool::ALL.len() - 1, "every tool but import_part is on both surfaces");
            assert!(agent.iter().all(|d| d.name != Tool::ImportPart.name()), "the in-app agent is not offered import_part");
            assert!(listed.iter().any(|t| t["name"] == Tool::ImportPart.name()), "MCP lists import_part");
            for tool in shared {
                let in_app = agent.iter().find(|d| d.name == tool.name()).unwrap_or_else(|| panic!("agent lacks {}", tool.name()));
                let external =
                    listed.iter().find(|t| t["name"] == tool.name()).unwrap_or_else(|| panic!("MCP lacks {}", tool.name()));
                assert_eq!(external["description"], in_app.description.as_str(), "{} description", tool.name());
                assert_eq!(external["inputSchema"], in_app.parameters, "{} schema", tool.name());
            }
            let build = listed.iter().find(|t| t["name"] == "build").expect("build");
            assert_eq!(build["inputSchema"]["properties"]["kind"]["enum"], kinds, "build offers exactly the app's kinds");
        }
    }

    #[tokio::test]
    async fn a_tool_that_is_not_listed_cannot_be_called() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, _state) = test_actions(dir.path());
        let server = McpServer::default();
        let url = server.set_enabled(actions.clone(), 0, true, || fixed("tok-unlisted")).await.expect("start").url.expect("url");
        // Human-only actions, and the sign-only names the generic tools replaced: there are no aliases.
        for name in ["approve_sign", "export_sign", "record_print_result", "build_sign", "get_sign", "list_signs", "show_sign"] {
            let (_, called) = list_then_call(&url, "tok-unlisted", name).await;
            assert!(called["result"].is_null(), "{name} ran: {called}");
            assert_eq!(called["error"]["message"], "tool not found", "{name}: {called}");
        }
        server.set_enabled(actions, 0, false, || fixed("unused")).await.expect("stop");
    }

    #[tokio::test]
    async fn a_failed_enable_is_not_remembered_as_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, state) = test_actions(dir.path());
        record_enabled(&state, false).expect("seed setting");
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("occupy a port");
        let port = taken.local_addr().expect("addr").port();
        let server = McpServer::default();
        let result = server
            .set_enabled_recording(actions, port, true, || fixed("tok"), |on| record_enabled(&state, on))
            .await;
        assert!(result.is_err(), "enabling on an occupied port fails: {result:?}");
        assert!(!server.status().await.running);
        assert!(!setting_enabled(&state).expect("read setting"), "the next launch must not start the endpoint");
    }

    #[tokio::test]
    async fn rotating_never_lets_go_of_the_port() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, _state) = test_actions(dir.path());
        let server = McpServer::default();
        let url = server.set_enabled(actions.clone(), 0, true, || fixed("old-token")).await.expect("start").url.expect("url");
        let port = server.running.lock().await.as_ref().expect("running").port;
        // Another program trying to take the port for as long as the rotation runs.
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let squatter = std::thread::spawn({
            let done = done.clone();
            move || loop {
                if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
                    return Some(listener);
                }
                if done.load(std::sync::atomic::Ordering::SeqCst) {
                    return None;
                }
            }
        });
        let rotated = server.rotate(|| fixed("new-token")).await;
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        let squatted = squatter.join().expect("squatter");
        assert_eq!(rotated, Ok("new-token".to_owned()));
        assert!(squatted.is_none(), "the port was free during rotation");
        assert_eq!(server.status().await.url.as_deref(), Some(url.as_str()));
        assert_eq!(initialize_status(&url, "old-token").await, 401);
        assert_eq!(initialize_status(&url, "new-token").await, 200);
        server.set_enabled(actions, 0, false, || fixed("unused")).await.expect("stop");
    }

    #[tokio::test]
    async fn a_dead_server_task_reads_as_off_and_can_be_turned_back_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (actions, _state) = test_actions(dir.path());
        let server = McpServer::default();
        server.set_enabled(actions.clone(), 0, true, || fixed("tok-dead")).await.expect("start");
        server.running.lock().await.as_ref().expect("running").task.abort();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while server.status().await.running {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("status reports the dead endpoint as off");
        let url = server.set_enabled(actions.clone(), 0, true, || fixed("tok-dead")).await.expect("restart").url.expect("url");
        assert_eq!(initialize_status(&url, "tok-dead").await, 200, "enabling again starts a live server");
        server.set_enabled(actions, 0, false, || fixed("unused")).await.expect("stop");
    }
}
