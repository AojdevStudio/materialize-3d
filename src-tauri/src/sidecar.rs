//! The sidecar: the Bun process that owns the app's chats and app documents.
//!
//! Rust starts it with none of the person's environment but what its tools need to run,
//! forwards the window's calls to it, answers its requests for the Keychain and the Bambu
//! slice step, and starts it again after a crash. Each side writes one JSON object per line
//! (`sidecar/src/protocol.ts`). Rust never opens the sidecar's store: it only names its folder.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch, Notify, OnceCell};

use crate::credentials;
use crate::fabrication::build_gate::{BuildGate, OwnedRunning};
use crate::state::AppState;
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
    /// Each slice by its operation id, running or done, for as long as the app runs.
    slices: Operations,
    /// The update gate's pass, held while the sidecar has work in flight, and the sidecar run it belongs to.
    pass: Mutex<Pass>,
}

#[derive(Default)]
struct Pass {
    /// How many sidecar runs ended. A run's requests carry the count from its start, so a request still on its way
    /// when its run ended never takes the pass.
    run: u64,
    held: Option<OwnedRunning<StateGate>>,
}

/// Outside work by operation id: one result each, shared by every request that names the id.
type Operations = Mutex<HashMap<String, Arc<OnceCell<Result<Value, String>>>>>;

/// Runs `work` once per operation id. A sidecar that crashed mid-slice leaves Rust's slice running, and its resumed
/// turn asks again with the same id: that request waits for the first and gets its result, so two slices never write
/// the same output, and a result that came after the crash is not lost.
async fn once_per_operation<F, Fut>(operations: &Operations, id: String, work: F) -> Result<Value, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    let cell = operations.lock().unwrap_or_else(|e| e.into_inner()).entry(id).or_default().clone();
    cell.get_or_init(work).await.clone()
}

/// The gate inside the app's state, so the sidecar's pass can own its way to it.
struct StateGate(Arc<AppState>);

impl std::ops::Deref for StateGate {
    type Target = BuildGate;
    fn deref(&self) -> &BuildGate {
        &self.0.builds
    }
}

/// The pass that holds an update off while the sidecar works. The updater restarts the app only once no build
/// and no sidecar work holds one. While an update installs, the gate is closed and the pass, and with it a send,
/// is refused.
fn take_pass(state: Arc<AppState>) -> Result<OwnedRunning<StateGate>, String> {
    BuildGate::enter_owned(StateGate(state))
        .ok_or_else(|| "An update is installing, and the app restarts when it is done. Send this again after it opens.".to_owned())
}

/// Runs `work` under a pass of its own. Work Rust does for the sidecar can outlive the sidecar run that asked for it,
/// as a slice does after a crash, so the run's pass cannot hold the update off for it.
async fn with_own_pass<F, Fut, T>(state: Arc<AppState>, work: F) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let _pass = take_pass(state)?;
    work().await
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
            slices: Mutex::default(),
            pass: Mutex::default(),
        }
    }
}

impl Sidecar {
    /// The run a sidecar process that starts now belongs to.
    fn run_started(&self) -> u64 {
        self.pass.lock().unwrap_or_else(|e| e.into_inner()).run
    }

    /// Work a sidecar was doing when it ended no longer holds an update off, and its requests still on their way take
    /// nothing. Its replacement asks again for work it resumes.
    fn run_ended(&self) {
        let mut pass = self.pass.lock().unwrap_or_else(|e| e.into_inner());
        pass.run += 1;
        pass.held = None;
    }

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

/// How long the login shell may take to tell its PATH before the app goes on without it.
const LOGIN_SHELL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// The PATH of the person's login shell. An app opened from Finder starts with
/// only the system folders, where `uv` is not.
fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let current = std::env::var("PATH").unwrap_or_default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
        match shell_path(&shell, LOGIN_SHELL_DEADLINE) {
            Some(path) if current.is_empty() => path,
            Some(path) => format!("{path}:{current}"),
            None => current,
        }
    })
}

/// The PATH `shell` reports as a login shell, or none when it fails, says nothing, or does not end within
/// `deadline`. A shell whose startup files hang is ended with all it started, so the sidecar and the runner still
/// start.
fn shell_path(shell: &str, deadline: std::time::Duration) -> Option<String> {
    let marker = "__M3D_PATH__";
    let end = std::time::Instant::now() + deadline;
    let mut command = std::process::Command::new(shell);
    command
        .args(["-ilc", &format!("printf '{marker}%s' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The shell leads a session of its own, so the deadline ends what its startup files started too. A session, not
    // only a group: a shell in a background group of the terminal the app started from stops before its startup
    // files, and one in a session of its own has no terminal to stop for.
    #[cfg(unix)]
    // SAFETY: setsid is async-signal-safe and only makes the child a session leader before it runs the shell.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // What the shell printed so far. A program its startup files started, such as an agent, can keep stdout open long
    // after the shell ends, so the reader is not waited on for its end.
    let printed = std::sync::Arc::new(Mutex::new(Vec::new()));
    let (closed, eof) = std::sync::mpsc::channel::<()>();
    std::thread::spawn({
        let printed = printed.clone();
        move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n @ 1..) = std::io::Read::read(&mut stdout, &mut chunk) {
                printed.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]);
            }
            let _ = closed.send(());
        }
    });
    // Startup files can send stdout elsewhere and go on running, so the shell's end has the deadline too.
    let ended = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if std::time::Instant::now() < end => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => break false,
        }
    };
    // The shell has ended, so all it printed is in the pipe: a short wait lets the reader take it.
    let _ = eof.recv_timeout(std::time::Duration::from_millis(100));
    let out = ended.then(|| std::mem::take(&mut *printed.lock().unwrap_or_else(|e| e.into_inner())));
    if !ended {
        #[cfg(unix)]
        if let Ok(group) = i32::try_from(child.id()) {
            // SAFETY: killpg only sends a signal, to the group this shell leads, as its session leader, and has not been
            // reaped from.
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    let out = out?;
    String::from_utf8_lossy(&out).rsplit_once(marker).map(|(_, path)| path.trim().to_owned()).filter(|path| !path.is_empty())
}

/// The only variables the sidecar gets. Its tools need a PATH that finds `uv` and a HOME for
/// uv's cache. The person's agent and inference settings (`ANTHROPIC_API_KEY` and the like) stay out.
fn kept_env() -> Vec<(&'static str, String)> {
    let mut env = vec![("PATH", login_path().to_owned())];
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
    let run = sidecar.run_started();

    let mut stdin = child.stdin.take().expect("piped stdin");
    let (input, mut lines_in) = mpsc::unbounded_channel::<String>();
    // Requests answer through a weak handle, so the link alone keeps stdin open and quitting closes it.
    let answers = input.downgrade();
    // Calls wait for the sidecar's ready event, which comes once it owns its store. A sidecar that exits because
    // another one still holds the store, as after a quick relaunch or an update, so never takes a call.
    let mut pending = Some(input);
    // A quit that came while this sidecar started has already stopped the link.
    if !matches!(*sidecar.link.borrow(), Link::Starting) {
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
                Ok(Some(line)) => {
                    if dispatch(app, run, &answers, &line) {
                        if let Some(input) = pending.take() {
                            // A quit that came while this sidecar started has already stopped the link: it must not
                            // reopen it.
                            let opened = sidecar.link.send_if_modified(|link| {
                                let open = matches!(link, Link::Starting);
                                if open {
                                    *link = Link::Up(input.clone());
                                }
                                open
                            });
                            if !opened {
                                let _ = child.start_kill();
                            }
                        }
                    }
                }
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
    sidecar.run_ended();
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

/// Handles one line from the sidecar, and says whether it was the sidecar's ready event.
fn dispatch(app: &AppHandle, run: u64, answers: &mpsc::WeakUnboundedSender<String>, line: &str) -> bool {
    let message = match serde_json::from_str::<Outbound>(line) {
        Ok(message) => message,
        Err(e) => {
            let start: String = line.chars().take(200).collect();
            log::error!("sidecar: not a protocol line ({e}): {start}");
            return false;
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
            let ready = event.get("type").and_then(Value::as_str) == Some("ready");
            let _ = app.emit(EVENT, event);
            return ready;
        }
        Outbound::Request { id, method, params } => {
            let app = app.clone();
            let answers = answers.clone();
            tauri::async_runtime::spawn(async move {
                let answer = match answer(&app, run, &method, params).await {
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
    false
}

fn parse<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("bad params for {method}: {e}"))
}

/// A slice the agent asked for, under its tool call's operation id.
#[derive(Deserialize)]
struct SliceCall {
    operation: String,
    #[serde(flatten)]
    request: studio::slice::Request,
}

#[derive(Deserialize)]
struct Busy {
    busy: bool,
}

/// Takes the update gate's pass for the sidecar run `run`, or gives it back. Taking it again while held changes
/// nothing. A run that ended changes nothing either.
fn set_busy(sidecar: &Sidecar, state: &Arc<AppState>, run: u64, busy: bool) -> Result<(), String> {
    let mut pass = sidecar.pass.lock().unwrap_or_else(|e| e.into_inner());
    if pass.run != run {
        return Err("This engine has exited.".to_owned());
    }
    match (busy, pass.held.is_some()) {
        (true, false) => pass.held = Some(take_pass(state.clone())?),
        (false, true) => pass.held = None,
        _ => {}
    }
    Ok(())
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

/// Answers one request from the sidecar run `run`. Errors name what failed and never carry a secret.
async fn answer(app: &AppHandle, run: u64, method: &str, params: Value) -> Result<Value, String> {
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
        "busy" => {
            let Busy { busy } = parse(method, params)?;
            set_busy(&app.state::<Sidecar>(), app.state::<Arc<AppState>>().inner(), run, busy)?;
            Ok(Value::Null)
        }
        "slice" => {
            let SliceCall { operation, request } = parse(method, params)?;
            let cache = app.path().app_cache_dir().map_err(|e| format!("finding the app's cache folder: {e}"))?.join("bambu-presets");
            // The pass comes first, so a refusal while an update installs is not kept as the operation's result, and
            // the same slice can run once the gate opens.
            let state = app.state::<Arc<AppState>>().inner().clone();
            let sidecar = app.state::<Sidecar>();
            with_own_pass(state, || {
                once_per_operation(&sidecar.slices, operation, || async move {
                    let sliced = tauri::async_runtime::spawn_blocking(move || studio::slice::slice(&request, &cache))
                        .await
                        .map_err(|e| format!("the slice task failed: {e}"))??;
                    serde_json::to_value(sliced).map_err(|e| e.to_string())
                })
            })
            .await
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

    #[cfg(unix)]
    #[test]
    fn a_login_shell_that_hangs_is_ended_at_its_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("slow-shell");
        std::fs::write(&shell, "#!/bin/sh\nsleep 30\n").unwrap();
        let mut perms = std::fs::metadata(&shell).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(&shell, perms).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(shell_path(shell.to_str().unwrap(), std::time::Duration::from_millis(300)), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());

        // Startup files that send stdout elsewhere and then hang end at the deadline too.
        std::fs::write(&shell, "#!/bin/sh\nexec >/dev/null\nsleep 30\n").unwrap();
        let started = std::time::Instant::now();
        assert_eq!(shell_path(shell.to_str().unwrap(), std::time::Duration::from_millis(300)), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
        assert!(shell_path("/bin/sh", std::time::Duration::from_secs(5)).is_some_and(|path| !path.is_empty()));
    }

    #[test]
    fn a_login_shell_that_leaves_a_program_holding_its_output_still_gives_its_path_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("agent-shell");
        // Startup files that start an agent, which keeps the shell's stdout open after the shell ends.
        std::fs::write(&shell, "#!/bin/sh
sleep 30 &
printf '__M3D_PATH__/opt/tools/bin'
").unwrap();
        let mut perms = std::fs::metadata(&shell).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(&shell, perms).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(shell_path(shell.to_str().unwrap(), std::time::Duration::from_secs(5)).as_deref(), Some("/opt/tools/bin"));
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "took {:?}", started.elapsed());
    }

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

    #[tokio::test]
    async fn a_repeated_operation_waits_for_the_first_and_gets_its_result() {
        let operations = Operations::default();
        let runs = AtomicU64::new(0);
        let work = |answer: &'static str| {
            let runs = &runs;
            move || async move {
                runs.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(json!(answer))
            }
        };
        let (first, again) = tokio::join!(
            once_per_operation(&operations, "op".to_owned(), work("first")),
            once_per_operation(&operations, "op".to_owned(), work("again")),
        );
        assert_eq!((first, again), (Ok(json!("first")), Ok(json!("first"))));
        assert_eq!(once_per_operation(&operations, "op".to_owned(), work("later")).await, Ok(json!("first")));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(once_per_operation(&operations, "other".to_owned(), work("other")).await, Ok(json!("other")));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }

    /// A slice that outlives its sidecar run keeps the update off until it ends, and none starts while one installs.
    #[tokio::test]
    async fn work_under_its_own_pass_holds_an_update_until_it_ends() {
        const SETTLE: Duration = Duration::from_millis(50);
        let state = Arc::new(AppState::default());
        let sidecar = Sidecar::default();
        set_busy(&sidecar, &state, 0, true).expect("the sidecar takes the pass");
        let (finish, finished) = oneshot::channel::<()>();
        let slice = tokio::spawn(with_own_pass(state.clone(), || async move {
            finished.await.map_err(|e| e.to_string())
        }));
        tokio::time::sleep(SETTLE).await;
        sidecar.run_ended();
        let mut close = std::pin::pin!(state.builds.close_when_idle(|_| {}));
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "the update waits for the slice its sidecar left");
        finish.send(()).expect("the slice is still running");
        slice.await.expect("the slice task").expect("the slice");
        let closed = tokio::time::timeout(SETTLE, &mut close).await.expect("the update goes ahead once the slice ends");
        let refused = with_own_pass(state.clone(), || async { Ok(()) }).await.expect_err("no slice starts while the update installs");
        assert!(refused.contains("update is installing"), "{refused}");
        drop(closed);
    }

    #[test]
    fn a_slice_call_carries_its_operation_id() {
        let call: SliceCall =
            serde_json::from_value(json!({ "operation": "abc", "project": "p", "inputs": ["a.stl"], "output": "out.3mf" })).expect("slice call");
        assert_eq!(call.operation, "abc");
        assert!(serde_json::from_value::<SliceCall>(json!({ "project": "p", "inputs": ["a.stl"], "output": "out.3mf" })).is_err());
    }

    /// The pass a busy sidecar takes holds an update off until it gives it back, and while the update installs
    /// the pass, and with it a send, is refused.
    #[tokio::test]
    async fn an_update_waits_for_a_busy_sidecar_and_refuses_it_work_while_it_installs() {
        const SETTLE: Duration = Duration::from_millis(50);
        let state = Arc::new(AppState::default());
        let sidecar = Sidecar::default();
        let run = sidecar.run_started();
        set_busy(&sidecar, &state, run, true).expect("the sidecar takes the pass");
        set_busy(&sidecar, &state, run, true).expect("asking again while it holds the pass changes nothing");
        let mut close = std::pin::pin!(state.builds.close_when_idle(|_| {}));
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "the update waits while the sidecar is busy");
        set_busy(&sidecar, &state, run, false).expect("the sidecar gives the pass back");
        let closed = tokio::time::timeout(SETTLE, &mut close).await.expect("the update goes ahead once the sidecar is idle");
        let refused = set_busy(&sidecar, &state, run, true).expect_err("work is refused while the update installs");
        assert!(refused.contains("update is installing"), "{refused}");
        drop(closed);
        set_busy(&sidecar, &state, run, true).expect("a failed install lets the sidecar work again");
    }

    /// A busy request from a sidecar that already exited, answered after its exit gave the pass back, takes
    /// nothing, so an idle replacement never leaves an update waiting.
    #[tokio::test]
    async fn a_sidecar_that_exited_cannot_take_the_pass() {
        let state = Arc::new(AppState::default());
        let sidecar = Sidecar::default();
        let exited = sidecar.run_started();
        sidecar.run_ended();
        let _replacement = sidecar.run_started();
        set_busy(&sidecar, &state, exited, true).expect_err("the exited sidecar's request is refused");
        let close = state.builds.close_when_idle(|_| {});
        let _closed = tokio::time::timeout(Duration::from_millis(50), close).await.expect("the update goes ahead");
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
