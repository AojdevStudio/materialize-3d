//! The `m3dremote://` protocol: the window's one way to reach the paired computer. Rust adds the device token, so the
//! window reads chats and model files by URL, as the desktop window reads `m3dfile://`.

use std::sync::LazyLock;
use std::time::Duration;

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::paired::Paired;

pub const SCHEME: &str = "m3dremote";
/// The window's origin on iOS. Its reads of `m3dremote://` cross origins, so every answer names it.
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

pub fn serve<R: Runtime>(context: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let pairing = context.app_handle().state::<Paired>().current();
    tauri::async_runtime::spawn(async move {
        let response = match pairing {
            None => text(StatusCode::UNAUTHORIZED, "This device is not paired with a computer.".into()),
            Some(pairing) => forward(&pairing, request).await.unwrap_or_else(|err| text(StatusCode::BAD_GATEWAY, format!("The computer did not answer. {err}"))),
        };
        let (mut parts, body) = response.into_parts();
        parts.headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, header::HeaderValue::from_static(WINDOW_ORIGIN));
        responder.respond(Response::from_parts(parts, body));
    });
}

/// Whether the token may go with this request. Tailscale Serve can mount other services under other paths of the same
/// origin, so the token goes only to the chat reads this window makes. `path` is the one sent, after `url` resolved it.
fn carries_token(method: &Method, path: &str) -> bool {
    *method == Method::GET && (path == "/api/v1/chats" || path.starts_with("/api/v1/chats/"))
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
    let mut body = Vec::new();
    while let Some(chunk) = reply.chunk().await? {
        if body.len() + chunk.len() > ANSWER_LIMIT {
            return Ok(text(StatusCode::PAYLOAD_TOO_LARGE, format!("This is too large to show on this device (over {} MB).", ANSWER_LIMIT / (1024 * 1024))));
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
    use super::{carries_token, url};
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
        assert!(sent(Method::GET, "/api/v1/chats"));
        assert!(sent(Method::GET, "/api/v1/chats/2026-11-08-cube/files/print/cube.3mf"));
        for path in ["/", "/other/service", "/api/v1/chatsx", "/api/v1/chats/../../admin", "/api/v1/chats/%2e%2e/%2e%2e/admin", "/api/v1/computer"] {
            assert!(!sent(Method::GET, path), "{path}");
        }
        assert!(!sent(Method::POST, "/api/v1/chats/2026-11-08-cube/send"));
    }
}
