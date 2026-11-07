//! The sidecar: the Bun process that owns the app's chats and app documents.
//!
//! Rust starts it with none of the person's environment but what its tools need to run,
//! forwards the window's calls to it, answers its requests for the Keychain and the Bambu
//! slice step, and starts it again after a crash. Each side writes one JSON object per line
//! (`sidecar/src/protocol.ts`). Rust never opens the sidecar's store: it only names its folder.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch, Notify};

use crate::credentials;
use crate::studio;

/// The one event the window listens to. The sidecar's own events and the engine's state both arrive here.
pub const EVENT: &str = "sidecar://event";
const BINARY: &str = "materialize-sidecar";
/// The sidecar exits with this when another process owns its store. Starting it again cannot help.
const EXIT_STORE_IN_USE: i32 = 75;
/// Crashes in a row, each within a minute of its start, before Rust stops starting it again.
const MAX_CRASHES: u32 = 5;
/// Tries, a second apart, while the store is in use. A sidecar that just ended can still be closing it; another
/// copy of the app holds it for longer than this.
const IN_USE_TRIES: u32 = 10;
/// Keychain items the sidecar may touch. Any other item, such as a printer's access code, is out of its reach.
const KEYCHAIN_PREFIX: &str = "inference.";

/// Whether the window's calls can reach a sidecar.
#[derive(Clone)]
enum Link {
    /// Starting or restarting. Calls wait.
    Starting,
    Up(mpsc::UnboundedSender<String>),
    /// No sidecar will run again in this session, and why. Calls fail with it.
    Stopped(String),
}

pub struct Sidecar {
    link: watch::Sender<Link>,
    calls: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_call: AtomicU64,
    quitting: AtomicBool,
    /// Whether a sidecar process runs, so quitting can wait for it to exit.
    alive: watch::Sender<bool>,
    /// Ends the running sidecar through its process handle, which never signals a reused pid.
    kill: Notify,
}

impl Default for Sidecar {
    fn default() -> Self {
        Self {
            link: watch::Sender::new(Link::Starting),
            calls: Mutex::default(),
            next_call: AtomicU64::new(1),
            quitting: AtomicBool::new(false),
            alive: watch::Sender::new(false),
            kill: Notify::new(),
        }
    }
}

impl Sidecar {
    /// Fails every call the sidecar that just exited will never answer.
    fn drop_calls(&self) {
        let calls = std::mem::take(&mut *self.calls.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, call) in calls {
            let _ = call.send(Err("The engine restarted before it answered. Try again.".to_owned()));
        }
    }

    fn stop(&self, app: &AppHandle, why: String) {
        log::error!("sidecar: stopped: {why}");
        self.link.send_replace(Link::Stopped(why.clone()));
        let _ = app.emit(EVENT, json!({ "type": "engine", "state": "stopped", "detail": why }));
    }

    /// Closes the sidecar's stdin, which tells it to finish its commits and exit, and waits up to five
    /// seconds before ending it. Its store keeps every commit, so a forced end loses nothing committed.
    pub fn shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        // The link holds the only lasting handle to stdin: calls drop theirs once their line is queued.
        self.link.send_replace(Link::Stopped("Materialize 3D is quitting.".to_owned()));
        let mut alive = self.alive.subscribe();
        tauri::async_runtime::block_on(async {
            if tokio::time::timeout(Duration::from_secs(5), alive.wait_for(|alive| !alive)).await.is_err() {
                log::warn!("sidecar: still running five seconds after quit, ending it");
                self.kill.notify_one();
                let _ = tokio::time::timeout(Duration::from_secs(2), alive.wait_for(|alive| !alive)).await;
            }
        });
    }
}

/// Starts the sidecar and keeps it running: after a crash it starts again, unless the crashes come
/// quickly in a row or another copy of the app owns the store.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut crashes = 0;
        let mut in_use = 0;
        loop {
            if app.state::<Sidecar>().quitting.load(Ordering::SeqCst) {
                return;
            }
            let started = Instant::now();
            let outcome = run(&app).await;
            let sidecar = app.state::<Sidecar>();
            if sidecar.quitting.load(Ordering::SeqCst) {
                return;
            }
            let why = match outcome {
                Ok(status) if status.code() == Some(EXIT_STORE_IN_USE) => {
                    in_use += 1;
                    if in_use >= IN_USE_TRIES {
                        sidecar.stop(&app, "Another copy of Materialize 3D is open. Quit it, then open this one again.".to_owned());
                        return;
                    }
                    log::warn!("sidecar: the store is still in use, trying again");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                Ok(status) => format!("the engine exited with {status}"),
                Err(e) => e,
            };
            in_use = 0;
            crashes = if started.elapsed() > Duration::from_secs(60) { 1 } else { crashes + 1 };
            if crashes >= MAX_CRASHES {
                sidecar.stop(&app, format!("The engine stopped {crashes} times in a row. The last time: {why}"));
                return;
            }
            log::error!("sidecar: {why}, starting it again");
            let _ = app.emit(EVENT, json!({ "type": "engine", "state": "restarting", "detail": why }));
            tokio::time::sleep(Duration::from_millis(500 * u64::from(crashes))).await;
        }
    });
}

/// Tauri puts an `externalBin` beside the app's own executable, without its target triple.
fn binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("finding the app's executable: {e}"))?;
    let dir = exe.parent().ok_or("the app's executable has no folder")?;
    Ok(dir.join(if cfg!(windows) { format!("{BINARY}.exe") } else { BINARY.to_owned() }))
}

/// The only variables the sidecar gets. Its tools need a PATH that finds `uv` and a HOME for
/// uv's cache. The person's agent and inference settings (`ANTHROPIC_API_KEY` and the like) stay out.
fn kept_env() -> Vec<(&'static str, String)> {
    let mut env = vec![("PATH", studio::turn::login_path().to_owned())];
    for name in ["HOME", "USER", "LANG", "TMPDIR"] {
        if let Ok(value) = std::env::var(name) {
            env.push((name, value));
        }
    }
    env
}

/// The sidecar's store goes in the app's Application Support folder, and project folders in Documents.
/// A verification run keeps both in its own data folder.
fn folders(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let data = app.path().app_data_dir().map_err(|e| format!("finding the app's data folder: {e}"))?;
    #[cfg(feature = "e2e")]
    let data = std::env::var_os("M3D_E2E_DATA_DIR").map(PathBuf::from).unwrap_or(data);
    Ok((data.join("state"), studio::projects_root()?))
}

/// One sidecar process, from its start until it exits.
async fn run(app: &AppHandle) -> Result<std::process::ExitStatus, String> {
    let exe = binary_path()?;
    let (store, projects) = folders(app)?;
    let mut child = tokio::process::Command::new(&exe)
        .args(["--app-version", &app.package_info().version.to_string()])
        .arg("--data")
        .arg(&store)
        .arg("--projects")
        .arg(&projects)
        .env_clear()
        .envs(kept_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("starting {}: {e}", exe.display()))?;
    let sidecar = app.state::<Sidecar>();
    sidecar.alive.send_replace(true);

    let mut stdin = child.stdin.take().expect("piped stdin");
    let (input, mut lines_in) = mpsc::unbounded_channel::<String>();
    // Requests answer through a weak handle, so the link alone keeps stdin open and quitting closes it.
    let answers = input.downgrade();
    // A quit that came while this sidecar started has already stopped the link: it must not reopen it.
    let opened = sidecar.link.send_if_modified(|link| {
        let open = matches!(link, Link::Starting);
        if open {
            *link = Link::Up(input.clone());
        }
        open
    });
    drop(input);
    if !opened {
        let _ = child.start_kill();
    }
    let writer = tokio::spawn(async move {
        while let Some(line) = lines_in.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let stderr = child.stderr.take().expect("piped stderr");
    let logger = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::info!("sidecar: {line}");
        }
    });

    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let read = loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => dispatch(app, &answers, &line),
                Ok(None) => break Ok(()),
                Err(e) => break Err(format!("reading the engine's output: {e}")),
            },
            () = sidecar.kill.notified() => {
                let _ = child.start_kill();
            }
        }
    };
    // No new call reaches this sidecar once the link is withdrawn, and none can queue a line once its writer is
    // gone. Only then are the calls it never answered failed, so no call is left waiting.
    sidecar.link.send_if_modified(|link| {
        let withdraw = matches!(link, Link::Up(_));
        if withdraw {
            *link = Link::Starting;
        }
        withdraw
    });
    writer.abort();
    let _ = writer.await;
    sidecar.drop_calls();
    // A sidecar can close its stdout and still hang, so the wait still answers a kill.
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|e| format!("waiting for the engine: {e}")),
            () = sidecar.kill.notified() => {
                let _ = child.start_kill();
            }
        }
    };
    sidecar.alive.send_replace(false);
    // A tool the sidecar started may hold its stderr open, so the last lines are not waited on for long.
    let _ = tokio::time::timeout(Duration::from_secs(1), logger).await;
    read?;
    status
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Outbound {
    Reply {
        id: u64,
        ok: bool,
        #[serde(default)]
        value: Value,
        #[serde(default)]
        error: Option<String>,
    },
    Request {
        id: u64,
        method: String,
        params: Value,
    },
    Event {
        event: Value,
    },
}

fn dispatch(app: &AppHandle, answers: &mpsc::WeakUnboundedSender<String>, line: &str) {
    let message = match serde_json::from_str::<Outbound>(line) {
        Ok(message) => message,
        Err(e) => {
            let start: String = line.chars().take(200).collect();
            log::error!("sidecar: not a protocol line ({e}): {start}");
            return;
        }
    };
    match message {
        Outbound::Reply { id, ok, value, error } => {
            let call = app.state::<Sidecar>().calls.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            match call {
                Some(call) => {
                    let _ = call.send(if ok { Ok(value) } else { Err(error.unwrap_or_else(|| "The engine refused the call.".to_owned())) });
                }
                None => log::error!("sidecar: a reply to no call: {id}"),
            }
        }
        Outbound::Event { event } => {
            let _ = app.emit(EVENT, event);
        }
        Outbound::Request { id, method, params } => {
            let app = app.clone();
            let answers = answers.clone();
            tauri::async_runtime::spawn(async move {
                let answer = match answer(&app, &method, params).await {
                    Ok(value) => json!({ "kind": "answer", "id": id, "ok": true, "value": value }),
                    Err(error) => json!({ "kind": "answer", "id": id, "ok": false, "error": error }),
                };
                // A sidecar that exited meanwhile has no one to read the answer.
                if let Some(answers) = answers.upgrade() {
                    let _ = answers.send(format!("{answer}\n"));
                }
            });
        }
    }
}

fn parse<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("bad params for {method}: {e}"))
}

#[derive(Deserialize)]
struct Account {
    account: String,
}

#[derive(Deserialize)]
struct NewSecret {
    account: String,
    secret: String,
}

/// The Keychain item for an inference login. The account is a provider id, never a path or another item's name.
fn keychain_item(account: &str) -> Result<String, String> {
    let valid = !account.is_empty()
        && account.len() <= 64
        && account.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if valid {
        Ok(format!("{KEYCHAIN_PREFIX}{account}"))
    } else {
        Err(format!("{account:?} is not a provider account"))
    }
}

/// Answers one request from the sidecar. Errors name what failed and never carry a secret.
async fn answer(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "keychain.get" => {
            let Account { account } = parse(method, params)?;
            let secret = credentials::get_credential(&keychain_item(&account)?).await?;
            Ok(json!({ "secret": secret }))
        }
        "keychain.set" => {
            let NewSecret { account, secret } = parse(method, params)?;
            credentials::store_credential(&keychain_item(&account)?, &secret).await?;
            Ok(Value::Null)
        }
        "keychain.delete" => {
            let Account { account } = parse(method, params)?;
            credentials::delete_credential(&keychain_item(&account)?).await?;
            Ok(Value::Null)
        }
        "slice" => {
            let request: studio::slice::Request = parse(method, params)?;
            let cache = app.path().app_cache_dir().map_err(|e| format!("finding the app's cache folder: {e}"))?.join("bambu-presets");
            let sliced = tauri::async_runtime::spawn_blocking(move || studio::slice::slice(&request, &cache))
                .await
                .map_err(|e| format!("the slice task failed: {e}"))??;
            serde_json::to_value(sliced).map_err(|e| e.to_string())
        }
        other => Err(format!("no host request {other}")),
    }
}

/// The window's one way to call the sidecar. A call made while the sidecar starts waits for it.
#[tauri::command]
pub async fn sidecar(sidecar: State<'_, Sidecar>, method: String, params: Value) -> Result<Value, String> {
    let link = sidecar.link.subscribe().wait_for(|link| !matches!(link, Link::Starting)).await.map_err(|e| e.to_string())?.clone();
    let input = match link {
        Link::Up(input) => input,
        Link::Stopped(why) => return Err(why),
        Link::Starting => unreachable!("waited until the link left Starting"),
    };
    let id = sidecar.next_call.fetch_add(1, Ordering::Relaxed);
    let (reply, replied) = oneshot::channel();
    sidecar.calls.lock().unwrap_or_else(|e| e.into_inner()).insert(id, reply);
    let line = json!({ "kind": "call", "id": id, "method": method, "params": params });
    let queued = input.send(format!("{line}\n")).is_ok();
    // Holding the sender while the reply is awaited would keep stdin open after quit.
    drop(input);
    if !queued {
        sidecar.calls.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return Err("The engine restarted before it answered. Try again.".to_owned());
    }
    replied.await.map_err(|_| "The engine restarted before it answered. Try again.".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sidecar_reaches_only_inference_items_in_the_keychain() {
        assert_eq!(keychain_item("anthropic").as_deref(), Ok("inference.anthropic"));
        assert_eq!(keychain_item("openai-codex").as_deref(), Ok("inference.openai-codex"));
        for bad in ["", "printer/access", "../printer", "Anthropic", "a b", &"x".repeat(65)] {
            assert!(keychain_item(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn the_sidecar_starts_with_none_of_the_persons_agent_settings() {
        let names: Vec<&str> = kept_env().into_iter().map(|(name, _)| name).collect();
        assert!(names.contains(&"PATH"));
        assert!(names.iter().all(|name| ["PATH", "HOME", "USER", "LANG", "TMPDIR"].contains(name)), "{names:?}");
    }

    #[test]
    fn a_protocol_line_parses_into_its_kind() {
        let request: Outbound = serde_json::from_str(r#"{"kind":"request","id":3,"method":"keychain.get","params":{"account":"anthropic"}}"#).expect("request");
        assert!(matches!(request, Outbound::Request { id: 3, ref method, .. } if method == "keychain.get"));
        let reply: Outbound = serde_json::from_str(r#"{"kind":"reply","id":1,"ok":false,"error":"no method x"}"#).expect("reply");
        assert!(matches!(reply, Outbound::Reply { id: 1, ok: false, error: Some(_), .. }));
        assert!(serde_json::from_str::<Outbound>(r#"{"kind":"mystery"}"#).is_err());
    }
}
