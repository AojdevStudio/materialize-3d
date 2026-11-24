//! The link to the paired computer's event stream. The `m3dremote://` protocol answers each request whole, so it
//! cannot carry a stream. Rust holds the stream open here and hands the window the link's state and each event.

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::header::{HeaderValue, CONTENT_TYPE};
use serde::Serialize;
use tauri::async_runtime::{self, JoinHandle};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::paired::{Paired, Pairing};

/// The wait before the next try after the link drops.
const RETRY: Duration = Duration::from_secs(2);

/// No redirects, so the token goes only to the paired origin. The computer writes a comment line every 15 seconds, so a
/// read that waits 40 seconds means the link is dead.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(40))
        .build()
        .expect("a client with timeouts")
});

/// What the window hears of the link. `Event` is one `data:` line of the stream, as the computer wrote it.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Link {
    Connected,
    Offline { detail: String },
    Event { event: serde_json::Value },
}

/// The one watcher. A new window, or a reload of it, replaces the one before.
#[derive(Default)]
pub struct Watcher(Mutex<Option<JoinHandle<()>>>);

#[tauri::command]
pub fn link_watch(channel: Channel<Link>, app: AppHandle, watcher: tauri::State<'_, Watcher>) {
    let task = async_runtime::spawn(async move {
        loop {
            let detail = match app.state::<Paired>().current() {
                None => "This device is not paired with a computer.".to_string(),
                Some(pairing) => watch(&pairing, &channel).await,
            };
            if channel.send(Link::Offline { detail }).is_err() {
                return;
            }
            tokio::time::sleep(RETRY).await;
        }
    });
    if let Some(before) = watcher.0.lock().expect("watcher lock").replace(task) {
        before.abort();
    }
}

/// Follows the stream until it fails or ends, and answers why.
async fn watch(pairing: &Pairing, channel: &Channel<Link>) -> String {
    let url = crate::remote::url(&pairing.origin, "/api/v1/events", None);
    let mut reply = match CLIENT.get(url).bearer_auth(&pairing.token).send().await {
        Ok(reply) => reply,
        Err(err) => return format!("The computer did not answer. {err}"),
    };
    let status = reply.status();
    if !status.is_success() {
        return format!("The computer refused the link ({status}). {}", reply.text().await.unwrap_or_default());
    }
    let kind = reply.headers().get(CONTENT_TYPE);
    if !is_event_stream(kind) {
        let named = kind.and_then(|kind| kind.to_str().ok()).unwrap_or("no content type");
        return format!("The computer answered the link with {named}, not an event stream.");
    }
    if channel.send(Link::Connected).is_err() {
        return "The window closed.".into();
    }
    let mut buffered = Vec::new();
    loop {
        match reply.chunk().await {
            Ok(Some(chunk)) => buffered.extend_from_slice(&chunk),
            Ok(None) => return "The computer ended the link.".into(),
            Err(err) => return format!("The link dropped. {err}"),
        }
        let events = match take_events(&mut buffered) {
            Ok(events) => events,
            Err(err) => return format!("The computer sent an event this app cannot read. {err}"),
        };
        for event in events {
            if channel.send(Link::Event { event }).is_err() {
                return "The window closed.".into();
            }
        }
    }
}

/// Whether a reply's content type is an event stream. A page a proxy answers in its place, such as a sign-in, is not.
fn is_event_stream(kind: Option<&HeaderValue>) -> bool {
    kind.and_then(|kind| kind.to_str().ok())
        .and_then(|kind| kind.split(';').next())
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("text/event-stream"))
}

/// Takes each whole event from the front of `buffered`, and leaves a part event for the next chunk. Comment lines,
/// the stream's keepalive, carry no event.
fn take_events(buffered: &mut Vec<u8>) -> Result<Vec<serde_json::Value>, serde_json::Error> {
    let mut events = Vec::new();
    while let Some(end) = buffered.windows(2).position(|pair| pair == b"\n\n") {
        let block: Vec<u8> = buffered.drain(..end + 2).collect();
        for line in String::from_utf8_lossy(&block).lines() {
            if let Some(data) = line.strip_prefix("data: ") {
                events.push(serde_json::from_str(data)?);
            }
        }
    }
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_split_across_chunks_come_out_whole_and_comments_carry_none() {
        let mut buffered = b": open\n\ndata: {\"type\":\"chat\",\"seq\":1}\n\ndata: {\"type\":".to_vec();
        assert_eq!(take_events(&mut buffered).expect("events"), vec![serde_json::json!({ "type": "chat", "seq": 1 })]);
        buffered.extend_from_slice(b"\"project\"}\n\n: keepalive\n\n");
        assert_eq!(take_events(&mut buffered).expect("events"), vec![serde_json::json!({ "type": "project" })]);
        assert!(buffered.is_empty());
    }

    #[test]
    fn only_an_event_stream_reply_is_a_link() {
        for kind in ["text/event-stream", "text/event-stream; charset=utf-8", "Text/Event-Stream"] {
            assert!(is_event_stream(Some(&HeaderValue::from_static(kind))), "{kind}");
        }
        for kind in [Some("text/html; charset=utf-8"), Some("application/json"), Some("text/event-streamx"), None] {
            assert!(!is_event_stream(kind.map(HeaderValue::from_static).as_ref()), "{kind:?}");
        }
    }
}
