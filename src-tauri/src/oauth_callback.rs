//! Minimal single-use OAuth callback HTTP server.
//!
//! Binds a TCP listener on `127.0.0.1:{port}`, waits for one HTTP request
//! from the system browser's OAuth redirect, extracts `code` and `state`
//! query parameters, and emits an `oauth:callback` Tauri event.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Payload emitted via the `oauth:callback` Tauri event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthCallbackResult {
    pub code: String,
    pub state: String,
}

/// Managed Tauri state holding the active callback server task handle.
pub struct OAuthCallbackState {
    pub handle: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl Default for OAuthCallbackState {
    fn default() -> Self {
        Self {
            handle: Arc::new(Mutex::new(None)),
        }
    }
}

/// Start a single-use OAuth callback server on the given port.
///
/// The server accepts one HTTP connection, extracts the auth code, responds
/// with a success page, emits the `oauth:callback` event, then shuts down.
pub async fn start_callback_server(port: u16, app_handle: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .map_err(|e| format!("oauth:callback-server bind failed on port={port}: {e}"))?;

    log::info!("oauth:callback-server-started port={port}");

    let (mut stream, _addr) = listener
        .accept()
        .await
        .map_err(|e| format!("oauth:callback-server accept failed: {e}"))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("oauth:callback-server read failed: {e}"))?;

    let request = String::from_utf8_lossy(&buf[..n]);

    match parse_callback_request(&request) {
        Some(result) => {
            let html = success_html();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                html.len(),
                html
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;

            log::info!("oauth:callback-received");
            app_handle
                .emit("oauth:callback", &result)
                .map_err(|e| format!("failed to emit oauth:callback event: {e}"))?;

            Ok(())
        }
        None => {
            let body = "Bad Request: missing code or state parameter";
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
            Err("oauth:callback-server received invalid callback (missing code or state)".into())
        }
    }
}

/// Stop the running callback server task, if any.
pub async fn stop_callback_server(state: &OAuthCallbackState) {
    let mut guard = state.handle.lock().await;
    if let Some(handle) = guard.take() {
        handle.abort();
        log::info!("oauth:callback-server-stopped");
    }
}

/// Parse an HTTP request line for OAuth callback paths and extract `code` + `state`.
///
/// Recognized paths: `/callback` (Anthropic) and `/auth/callback` (OpenAI).
fn parse_callback_request(request: &str) -> Option<OAuthCallbackResult> {
    // Extract the request line (e.g. "GET /callback?code=abc&state=xyz HTTP/1.1")
    let request_line = request.lines().next()?;
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }

    let full_path = parts[1];
    let (path, query) = if let Some(idx) = full_path.find('?') {
        (&full_path[..idx], &full_path[idx + 1..])
    } else {
        (full_path, "")
    };

    // Only accept recognized callback paths
    if path != "/callback" && path != "/auth/callback" {
        return None;
    }

    let params = parse_query_string(query);
    let code = params.iter().find(|(k, _)| k == "code").map(|(_, v)| v.clone())?;
    let state = params.iter().find(|(k, _)| k == "state").map(|(_, v)| v.clone())?;

    Some(OAuthCallbackResult { code, state })
}

/// Parse a URL query string into key-value pairs.
fn parse_query_string(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?.to_string();
            let value = parts.next().unwrap_or("").to_string();
            Some((key, value))
        })
        .collect()
}

/// HTML page shown to the user after a successful OAuth callback.
fn success_html() -> String {
    r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Materialize 3D</title></head>
<body style="font-family: system-ui; text-align: center; padding: 60px;">
<h1>&#10003; Authorization Successful</h1>
<p>You can close this tab and return to Materialize 3D.</p>
</body>
</html>"#
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_anthropic_callback() {
        let request = "GET /callback?code=auth_code_123&state=state_abc HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let result = parse_callback_request(request).expect("should parse Anthropic callback");
        assert_eq!(result.code, "auth_code_123");
        assert_eq!(result.state, "state_abc");
    }

    #[test]
    fn parse_openai_callback() {
        let request = "GET /auth/callback?code=oai_code_456&state=state_def HTTP/1.1\r\nHost: localhost\r\n\r\n";
        let result = parse_callback_request(request).expect("should parse OpenAI callback");
        assert_eq!(result.code, "oai_code_456");
        assert_eq!(result.state, "state_def");
    }

    #[test]
    fn reject_unknown_path() {
        let request = "GET /other?code=abc&state=def HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(parse_callback_request(request).is_none());
    }

    #[test]
    fn reject_missing_code() {
        let request = "GET /callback?state=xyz HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(parse_callback_request(request).is_none());
    }

    #[test]
    fn reject_missing_state() {
        let request = "GET /callback?code=abc HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(parse_callback_request(request).is_none());
    }

    #[test]
    fn reject_empty_request() {
        assert!(parse_callback_request("").is_none());
    }

    #[test]
    fn reject_no_query_string() {
        let request = "GET /callback HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(parse_callback_request(request).is_none());
    }

    #[test]
    fn parse_query_string_basic() {
        let params = parse_query_string("code=abc&state=def&extra=ghi");
        assert_eq!(params.len(), 3);
        assert_eq!(params[0], ("code".into(), "abc".into()));
        assert_eq!(params[1], ("state".into(), "def".into()));
        assert_eq!(params[2], ("extra".into(), "ghi".into()));
    }

    #[test]
    fn parse_query_string_empty() {
        let params = parse_query_string("");
        assert!(params.is_empty());
    }

    #[test]
    fn parse_query_string_key_only() {
        let params = parse_query_string("key_only");
        assert_eq!(params.len(), 1);
        assert_eq!(params[0], ("key_only".into(), "".into()));
    }

    #[test]
    fn success_html_contains_expected_content() {
        let html = success_html();
        assert!(html.contains("Authorization Successful"));
        assert!(html.contains("Materialize 3D"));
    }
}
