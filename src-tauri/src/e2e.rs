//! Verification harness for driving the real app where WebDriver is not
//! available (macOS WKWebView). Compiled only with `--features e2e`; release
//! builds never contain it.
//!
//! Starts only when both `M3D_E2E_PORT` and `M3D_E2E_TOKEN` are set, binds
//! 127.0.0.1, and requires `Authorization: Bearer <token>`:
//! - `POST /eval` `{ "script": "...", "timeoutMs": 15000 }` runs an async
//!   function body in the main webview and returns `{ ok, value }`, where
//!   `value` is the JSON-encoded return value or the error text.
//! - `GET /snapshot` returns a PNG of the webview (macOS only).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<EvalResult>>>>;

#[derive(Clone)]
struct Harness {
    app: AppHandle,
    pending: Pending,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalRequest {
    script: String,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EvalResult {
    ok: bool,
    value: String,
}

#[derive(Deserialize)]
struct EvalMessage {
    id: String,
    ok: bool,
    value: String,
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let (Ok(port), Ok(token)) = (std::env::var("M3D_E2E_PORT"), std::env::var("M3D_E2E_TOKEN")) else {
        return Ok(());
    };
    let port: u16 = port.parse().map_err(|e| format!("M3D_E2E_PORT: {e}"))?;
    if token.len() < 16 {
        return Err("M3D_E2E_TOKEN must be at least 16 characters".into());
    }
    let pending: Pending = Arc::default();
    let listener_pending = pending.clone();
    app.listen("e2e:result", move |event| {
        let Ok(message) = serde_json::from_str::<EvalMessage>(event.payload()) else { return };
        if let Some(sender) = listener_pending.lock().ok().and_then(|mut map| map.remove(&message.id)) {
            let _ = sender.send(EvalResult { ok: message.ok, value: message.value });
        }
    });
    let harness = Harness { app: app.clone(), pending };
    let router = axum::Router::new()
        .route("/eval", post(eval))
        .route("/snapshot", get(snapshot))
        .route("/health", get(|| async { "ok" }))
        .with_state(harness)
        .layer(middleware::from_fn_with_state(Arc::<str>::from(token), require_bearer));
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                log::warn!("e2e: verification harness listening on 127.0.0.1:{port}");
                if let Err(err) = axum::serve(listener, router).await {
                    log::error!("e2e: server stopped: {err}");
                }
            }
            Err(err) => log::error!("e2e: bind 127.0.0.1:{port}: {err}"),
        }
    });
    Ok(())
}

async fn require_bearer(State(token): State<Arc<str>>, req: Request, next: Next) -> Result<Response, StatusCode> {
    let authorized = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|presented| presented == &*token);
    if authorized {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn eval(State(harness): State<Harness>, Json(request): Json<EvalRequest>) -> Response {
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    if let Ok(mut map) = harness.pending.lock() {
        map.insert(id.clone(), sender);
    }
    let emit = |ok: &str, value: &str| {
        format!("window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{{event:'e2e:result',payload:{{id:'{id}',ok:{ok},value:{value}}}}})")
    };
    let script = format!(
        "(async()=>{{try{{const __v=await (async()=>{{{body}\n}})();{done}}}catch(__e){{{fail}}}}})()",
        body = request.script,
        done = emit("true", "JSON.stringify(__v===undefined?null:__v)"),
        fail = emit("false", "String((__e&&__e.stack)||__e)"),
    );
    let Some(webview) = harness.app.get_webview("main") else {
        return (StatusCode::SERVICE_UNAVAILABLE, "main webview not ready").into_response();
    };
    if let Err(err) = webview.eval(&script) {
        return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
    }
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(15_000));
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(result)) => Json(result).into_response(),
        _ => {
            if let Ok(mut map) = harness.pending.lock() {
                map.remove(&id);
            }
            (StatusCode::GATEWAY_TIMEOUT, "script did not settle in time").into_response()
        }
    }
}

async fn snapshot(State(harness): State<Harness>) -> Response {
    match platform::snapshot_png(&harness.app).await {
        Ok(png) => ([(header::CONTENT_TYPE, "image/png")], png).into_response(),
        Err(err) => (StatusCode::NOT_IMPLEMENTED, err).into_response(),
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    use tauri::{AppHandle, Manager};
    use tokio::sync::oneshot;

    /// Snapshots the webview's own content through WebKit, which needs no
    /// Screen Recording permission.
    pub async fn snapshot_png(app: &AppHandle) -> Result<Vec<u8>, String> {
        let webview = app.get_webview("main").ok_or("main webview not ready")?;
        let (sender, receiver) = oneshot::channel::<Result<Vec<u8>, String>>();
        let sender = Mutex::new(Some(sender));
        webview
            .with_webview(move |platform| {
                let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    // SAFETY: WebKit passes either a valid NSImage or a valid NSError for the call's duration.
                    let result = unsafe { image.as_ref() }
                        .ok_or_else(|| unsafe { error.as_ref() }.map_or("snapshot failed".into(), |e| e.to_string()))
                        .and_then(png_bytes);
                    if let Some(sender) = sender.lock().ok().and_then(|mut s| s.take()) {
                        let _ = sender.send(result);
                    }
                });
                // SAFETY: on macOS `inner()` is the live WKWebView, and this closure runs on the main thread.
                unsafe {
                    let view: &WKWebView = &*platform.inner().cast();
                    view.takeSnapshotWithConfiguration_completionHandler(None, &block);
                }
            })
            .map_err(|e| e.to_string())?;
        receiver.await.map_err(|_| "snapshot callback dropped".to_string())?
    }

    fn png_bytes(image: &NSImage) -> Result<Vec<u8>, String> {
        let tiff = image.TIFFRepresentation().ok_or("image has no TIFF representation")?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("could not decode snapshot")?;
        // SAFETY: an empty properties dictionary is valid for PNG encoding.
        let png = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
        .ok_or("could not encode PNG")?;
        Ok(png.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub async fn snapshot_png(_app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
        Err("snapshot is implemented for macOS only; use WebDriver on Linux".into())
    }
}
