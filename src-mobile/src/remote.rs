//! The `m3dremote://` protocol: the window's one way to reach the paired computer. Rust adds the device token, so the
//! window reads chats and model files by URL, as the desktop window reads `m3dfile://`.

use std::sync::LazyLock;
use std::time::Duration;

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use tokio::sync::watch;

use crate::paired::Paired;

pub const SCHEME: &str = "m3dremote";
/// The window's origin on iOS. Its reads and sends through `m3dremote://` cross origins, so every answer names it.
const WINDOW_ORIGIN: &str = "tauri://localhost";
/// The most of one answer the phone holds. A larger model would exhaust its memory before the person could pick a
/// smaller one, so it is refused and the rest of the chat stays usable.
const ANSWER_LIMIT: usize = 64 * 1024 * 1024;

/// No redirects, so the token goes only to the paired origin. The deadlines turn a computer that stops answering into
/// an error the window can show, over cellular too.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .build()
        .expect("a TLS client")
});

pub fn client() -> &'static reqwest::Client {
    &CLIENT
}

/// The paired origin with a path and query set on it. Setting them, not joining them, keeps the host: a path such as
/// `//other.example/x` stays a path on the paired computer.
pub fn url(origin: &url::Url, path: &str, query: Option<&str>) -> url::Url {
    let mut url = origin.clone();
    url.set_path(path);
    url.set_query(query);
    url
}

/// The model download the window wants now. Each model-file read takes the next number, and a newer model read, or
/// the window leaving the chat, makes the older ones stale. A stale read stops at once and drops its connection, so a
/// phone on cellular never keeps downloading a preview it will not show.
pub struct ModelReads(watch::Sender<u64>);

impl Default for ModelReads {
    fn default() -> Self {
        ModelReads(watch::channel(0).0)
    }
}

impl ModelReads {
    /// A ticket for a new model read, and the watch that says when it went stale.
    fn start(&self) -> (u64, watch::Receiver<u64>) {
        let mut ticket = 0;
        self.0.send_modify(|current| {
            *current += 1;
            ticket = *current;
        });
        (ticket, self.0.subscribe())
    }

    fn stop(&self) {
        self.0.send_modify(|current| *current += 1);
    }
}

/// The window calls this when it leaves a chat, so that chat's model download stops.
#[tauri::command]
pub fn stop_model_reads(reads: tauri::State<'_, ModelReads>) {
    reads.stop();
}

/// Whether a read fetches a model file, the one kind of read a newer one replaces.
fn is_model_read(path: &str) -> bool {
    matches!(path.split('/').skip(1).collect::<Vec<_>>().as_slice(), ["api", "v1", "chats", _, "files", _, ..])
}

pub fn serve<R: Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = context.app_handle();
    let pairing = app.state::<Paired>().current();
    let model_read = is_model_read(request.uri().path()).then(|| app.state::<ModelReads>().start());
    tauri::async_runtime::spawn(async move {
        let response = match pairing {
            // A JSON send asks first whether it may cross origins. The computer never sees that question.
            _ if request.method() == Method::OPTIONS => Response::builder()
                .status(StatusCode::NO_CONTENT)
                .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, PUT, POST")
                .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type")
                .body(Vec::new())
                .expect("a preflight answer"),
            None => text(StatusCode::UNAUTHORIZED, "This device is not paired with a computer.".into()),
            Some(pairing) => {
                let answer = forward(&pairing, request);
                let answer = match model_read {
                    // Dropping the forward stops the download where it is.
                    Some((ticket, mut current)) => tokio::select! {
                        answer = answer => answer,
                        _ = current.wait_for(|now| *now != ticket) => Ok(text(StatusCode::CONFLICT, "A newer model read took this one's place.".into())),
                    },
                    None => answer.await,
                };
                answer.unwrap_or_else(|err| text(StatusCode::BAD_GATEWAY, format!("The computer did not answer. {err}")))
            }
        };
        let (mut parts, body) = response.into_parts();
        parts.headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, header::HeaderValue::from_static(WINDOW_ORIGIN));
        responder.respond(Response::from_parts(parts, body));
    });
}

/// Whether the token may go with this request. Tailscale Serve can mount other services under other paths of the same
/// origin, and it decodes a path before it picks a mount, so the token goes only with the four chat reads this window
/// makes, segment by segment, and never with an encoded slash or backslash. `path` is the one sent, after `url`
/// resolved it.
fn carries_token(method: &Method, path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if *method != Method::GET || lower.contains("%2f") || lower.contains("%5c") || path.contains('\\') {
        return false;
    }
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    match segments.as_slice() {
        ["api", "v1", "chats"] => true,
        ["api", "v1", "chats", project] => !project.is_empty(),
        ["api", "v1", "chats", project, "files"] => !project.is_empty(),
        ["api", "v1", "chats", project, "files", rel @ ..] => !project.is_empty() && !rel.is_empty() && rel.iter().all(|part| !part.is_empty()),
        _ => false,
    }
}

async fn forward(pairing: &crate::paired::Pairing, request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, reqwest::Error> {
    let target = url(&pairing.origin, request.uri().path(), request.uri().query());
    if !carries_token(request.method(), target.path()) {
        return Ok(text(StatusCode::FORBIDDEN, format!("This app does not send {} {} to the computer.", request.method(), target.path())));
    }
    let mut outgoing = client().request(request.method().clone(), target).bearer_auth(&pairing.token);
    if let Some(kind) = request.headers().get(header::CONTENT_TYPE) {
        outgoing = outgoing.header(header::CONTENT_TYPE, kind);
    }
    let mut reply = outgoing.body(request.into_body()).send().await?;
    let mut response = Response::builder().status(reply.status());
    if let Some(kind) = reply.headers().get(header::CONTENT_TYPE) {
        response = response.header(header::CONTENT_TYPE, kind);
    }
    // Counted as it arrives: a streamed answer has no length to check first.
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = reply.chunk().await? {
        let needed = body.len() + chunk.len();
        if needed > ANSWER_LIMIT {
            return Ok(text(StatusCode::PAYLOAD_TOO_LARGE, format!("This is too large to show on this device (over {} MB).", ANSWER_LIMIT / (1024 * 1024))));
        }
        // Doubling, as Vec would, but never past the limit, so the buffer never holds more than the limit allows.
        if needed > body.capacity() {
            body.reserve_exact((body.capacity() * 2).clamp(needed, ANSWER_LIMIT) - body.len());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(response.body(body).expect("a status and a content type make a response"))
}

fn text(status: StatusCode, body: String) -> Response<Vec<u8>> {
    Response::builder().status(status).header(header::CONTENT_TYPE, "text/plain; charset=utf-8").body(body.into_bytes()).expect("a plain response")
}

#[cfg(test)]
mod tests {
    use super::{carries_token, is_model_read, url, ModelReads};
    use tauri::http::Method;

    #[test]
    fn a_request_path_never_leaves_the_paired_computer() {
        let origin = url::Url::parse("https://studio.tail1234.ts.net:47380/").expect("an origin");
        for path in ["//other.example/x", "/..//other.example/x", "/@other.example/x", "/api/v1/chats"] {
            let target = url(&origin, path, Some("a=1"));
            assert_eq!(target.host_str(), Some("studio.tail1234.ts.net"), "{path}");
            assert_eq!(target.port(), Some(47380), "{path}");
        }
    }

    #[test]
    fn the_token_goes_only_with_chat_reads() {
        let origin = url::Url::parse("https://studio.tail1234.ts.net:47380/").expect("an origin");
        let sent = |method: Method, path: &str| carries_token(&method, url(&origin, path, None).path());
        for path in ["/api/v1/chats", "/api/v1/chats/2026-11-08-cube", "/api/v1/chats/2026-11-08-cube/files", "/api/v1/chats/2026-11-08-cube/files/print/cube.3mf"] {
            assert!(sent(Method::GET, path), "{path}");
        }
        for path in [
            "/",
            "/other/service",
            "/api/v1/chatsx",
            "/api/v1/chats/",
            "/api/v1/chats/../../admin",
            "/api/v1/chats/%2e%2e/%2e%2e/admin",
            "/api/v1/chats/2026-11-08-cube%2Fother",
            "/api/v1/chats/2026-11-08-cube/files/a%2fb.stl",
            "/api/v1/chats/2026-11-08-cube/files/a%5Cb.stl",
            "/api/v1/chats/2026-11-08-cube/other",
            "/api/v1/chats/2026-11-08-cube/files/",
            "/api/v1/computer",
        ] {
            assert!(!sent(Method::GET, path), "{path}");
        }
        assert!(!sent(Method::POST, "/api/v1/chats/2026-11-08-cube/send"));
    }

    #[test]
    fn a_newer_model_read_or_leaving_the_chat_makes_the_older_read_stale() {
        let reads = ModelReads::default();
        let (first, watch_first) = reads.start();
        assert_eq!(*watch_first.borrow(), first, "a read is current when it starts");
        let (second, watch_second) = reads.start();
        assert_ne!(*watch_first.borrow(), first, "a newer read makes the first stale");
        assert_eq!(*watch_second.borrow(), second);
        reads.stop();
        assert_ne!(*watch_second.borrow(), second, "leaving the chat makes the last read stale");
    }

    #[test]
    fn only_model_file_reads_replace_each_other() {
        assert!(is_model_read("/api/v1/chats/2026-11-08-cube/files/cube.stl"));
        assert!(is_model_read("/api/v1/chats/2026-11-08-cube/files/print/cube.3mf"));
        for path in ["/api/v1/chats", "/api/v1/chats/2026-11-08-cube", "/api/v1/chats/2026-11-08-cube/files"] {
            assert!(!is_model_read(path), "{path}");
        }
    }
}
