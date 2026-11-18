//! The sidecar: the Bun process that owns the app's chats and app documents.
//!
//! Rust starts it with none of the person's environment but what its tools need to run,
//! forwards the window's calls to it, answers its requests for the Keychain and the Bambu
//! slice step, and starts it again after a crash. Each side writes one JSON object per line
//! (`sidecar/src/protocol.ts`). Rust never opens the sidecar's store: it only names its folder.
//! `sidecar/test/fixtures/contract.json` holds the values both sides share, and each side's tests check them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch, Notify};

use crate::build_gate::{BuildGate, OwnedRunning};
use crate::slice_requests::{self, SliceCall, Slices};
use crate::{credentials, login_shell, studio};

/// The one event the window listens to. The sidecar's own events and the engine's state both arrive here.
pub const EVENT: &str = "sidecar://event";
const BINARY: &str = "materialize-sidecar";
const APP_VERSION_FLAG: &str = "--app-version";
const DATA_FLAG: &str = "--data";
const PROJECTS_FLAG: &str = "--projects";
/// The sidecar keeps its pasted pictures beside this folder, in the app's data folder.
const STORE_FOLDER: &str = "state";
/// The variables the sidecar gets as they are. Its PATH is the login shell's.
const PASSED_ENV: [&str; 4] = ["HOME", "USER", "LANG", "TMPDIR"];
/// The sidecar exits with this once its input closes.
const EXIT_DONE: i32 = 0;
/// The sidecar exits with this when another process owns its store. Starting it again cannot help.
const EXIT_STORE_IN_USE: i32 = 75;
/// Crashes in a row, each within a minute of its start, before Rust stops starting it again.
const MAX_CRASHES: u32 = 5;
/// Tries, a second apart, while the store is in use. A sidecar that just ended can still be closing it; another
/// copy of the app holds it for longer than this.
const IN_USE_TRIES: u32 = 10;
const RESTARTED: &str = "The engine restarted before it answered. Try again.";

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
    /// The update gate's pass, held while the sidecar has work in flight, and the sidecar run it belongs to.
    pass: Mutex<Pass>,
}

#[derive(Default)]
struct Pass {
    /// How many sidecar runs ended. A run's requests carry the count from its start, so a request still on its way
    /// when its run ended never takes the pass.
    run: u64,
    held: Option<OwnedRunning<Arc<BuildGate>>>,
}

/// The pass that holds an update off while the sidecar works. The updater restarts the app only once no slice
/// and no sidecar work holds one. While an update installs, the gate is closed and the pass, and with it a send,
/// is refused.
fn take_pass(gate: Arc<BuildGate>) -> Result<OwnedRunning<Arc<BuildGate>>, String> {
    BuildGate::enter_owned(gate)
        .ok_or_else(|| "An update is installing, and the app restarts when it is done. Send this again after it opens.".to_owned())
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
            pass: Mutex::default(),
        }
    }
}

impl Sidecar {
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
            let _ = call.send(Err(RESTARTED.to_owned()));
        }
    }

    fn stop(&self, app: &AppHandle, why: String) {
        log::error!("sidecar: stopped: {why}");
        self.link.send_replace(Link::Stopped(why.clone()));
        let _ = app.emit(EVENT, EngineEvent { state: EngineState::Stopped, detail: why });
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
                // Rust closes the sidecar's input only to quit, which returned above. An input that closed any other
                // way ends it like a crash.
                Ok(status) if status.code() == Some(EXIT_DONE) => format!("the engine exited with {status}"),
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
            let _ = app.emit(EVENT, EngineEvent { state: EngineState::Restarting, detail: why });
            tokio::time::sleep(Duration::from_millis(500 * u64::from(crashes))).await;
        }
    });
}

/// Tauri puts an `externalBin` beside the app's own executable, without its target triple.
fn binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("finding the app's executable: {e}"))?;
    let dir = exe.parent().ok_or("the app's executable has no folder")?;
    Ok(dir.join(BINARY))
}

/// The only variables the sidecar gets. Its tools need a PATH that finds `uv` and a HOME for
/// uv's cache. The person's agent and inference settings (`ANTHROPIC_API_KEY` and the like) stay out.
fn kept_env() -> Vec<(&'static str, String)> {
    let mut env = vec![("PATH", login_shell::path().to_owned())];
    for name in PASSED_ENV {
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
    let data = studio::e2e_data_dir().unwrap_or(data);
    Ok((data.join(STORE_FOLDER), studio::projects_root()?))
}

async fn run(app: &AppHandle) -> Result<std::process::ExitStatus, String> {
    let exe = binary_path()?;
    let (store, projects) = folders(app)?;
    let mut child = tokio::process::Command::new(&exe)
        .args([APP_VERSION_FLAG, &app.package_info().version.to_string()])
        .arg(DATA_FLAG)
        .arg(&store)
        .arg(PROJECTS_FLAG)
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

/// A line from the sidecar.
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

/// A line to the sidecar.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Inbound<'a> {
    Call {
        id: u64,
        method: &'a str,
        params: &'a Value,
    },
    Answer {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

impl Inbound<'_> {
    fn answer(id: u64, answer: Result<Value, String>) -> Self {
        match answer {
            Ok(value) => Self::Answer { id, ok: true, value: Some(value), error: None },
            Err(error) => Self::Answer { id, ok: false, value: None, error: Some(error) },
        }
    }

    fn line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("a line of plain JSON values");
        line.push('\n');
        line
    }
}

/// The engine's state, which Rust tells the window on the sidecar's event channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename = "engine")]
struct EngineEvent {
    state: EngineState,
    detail: String,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum EngineState {
    Restarting,
    Stopped,
}

/// Handles one line from the sidecar, and says whether it was the sidecar's ready event.
fn dispatch<R: Runtime>(app: &AppHandle<R>, run: u64, answers: &mpsc::WeakUnboundedSender<String>, line: &str) -> bool {
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
                let line = Inbound::answer(id, answer(&app, run, &method, params).await).line();
                // A sidecar that exited meanwhile has no one to read the answer.
                if let Some(answers) = answers.upgrade() {
                    let _ = answers.send(line);
                }
            });
        }
    }
    false
}

fn parse<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|e| format!("bad params for {method}: {e}"))
}

#[derive(Deserialize)]
struct Busy {
    busy: bool,
}

/// Takes the update gate's pass for the sidecar run `run`, or gives it back. Taking it again while held changes
/// nothing. A run that ended changes nothing either.
fn set_busy(sidecar: &Sidecar, gate: &Arc<BuildGate>, run: u64, busy: bool) -> Result<(), String> {
    let mut pass = sidecar.pass.lock().unwrap_or_else(|e| e.into_inner());
    if pass.run != run {
        return Err("This engine has exited.".to_owned());
    }
    match (busy, pass.held.is_some()) {
        (true, false) => pass.held = Some(take_pass(gate.clone())?),
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

/// Answers one request from the sidecar run `run`. Errors name what failed and never carry a secret.
async fn answer<R: Runtime>(app: &AppHandle<R>, run: u64, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "keychain.get" => {
            let Account { account } = parse(method, params)?;
            let secret = credentials::get_credential(&credentials::keychain_item(&account)?).await?;
            Ok(json!({ "secret": secret }))
        }
        "keychain.set" => {
            let NewSecret { account, secret } = parse(method, params)?;
            credentials::store_credential(&credentials::keychain_item(&account)?, &secret).await?;
            Ok(Value::Null)
        }
        "keychain.delete" => {
            let Account { account } = parse(method, params)?;
            credentials::delete_credential(&credentials::keychain_item(&account)?).await?;
            Ok(Value::Null)
        }
        "busy" => {
            let Busy { busy } = parse(method, params)?;
            set_busy(&app.state::<Sidecar>(), app.state::<Arc<BuildGate>>().inner(), run, busy)?;
            Ok(Value::Null)
        }
        "printer.check" => slice_requests::check(app, parse(method, params)?).await,
        "slice" => {
            let call: SliceCall = parse(method, params)?;
            let cache = slice_requests::preset_cache(app)?;
            // A slice can outlive the sidecar run that asked for it, as it does after a crash, so it holds a pass of its
            // own and not the run's. The pass comes before the slice, so a refusal while an update installs is not kept
            // as the operation's result, and the same slice can run once the gate opens.
            let _pass = take_pass(app.state::<Arc<BuildGate>>().inner().clone())?;
            slice_requests::slice(&app.state::<Slices>(), call, cache).await
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
    let queued = input.send(Inbound::Call { id, method: &method, params: &params }.line()).is_ok();
    // Holding the sender while the reply is awaited would keep stdin open after quit.
    drop(input);
    if !queued {
        sidecar.calls.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        return Err(RESTARTED.to_owned());
    }
    replied.await.map_err(|_| RESTARTED.to_owned())?
}

#[cfg(test)]
pub(crate) mod tests {
    use tauri::Listener;

    use super::*;

    /// `sidecar/test/fixtures/contract.json`, which the sidecar's tests check their side against.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub(crate) struct Contract {
        binary: String,
        flags: Flags,
        folders: Folders,
        env: Vec<String>,
        exit: Exit,
        engine_events: Vec<Value>,
        host_requests: Vec<String>,
        pub(crate) keychain_prefix: String,
        pub(crate) providers: Vec<String>,
        pub(crate) meta_dir: String,
        pub(crate) skipped: Skipped,
        pub(crate) projects: Projects,
        pub(crate) plates: Vec<String>,
        pub(crate) printers: Vec<Value>,
        lines: Lines,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Flags {
        app_version: String,
        data: String,
        projects: String,
    }

    #[derive(Deserialize)]
    struct Folders {
        store: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Exit {
        done: i32,
        store_in_use: i32,
    }

    #[derive(Deserialize)]
    pub(crate) struct Skipped {
        pub(crate) names: Vec<String>,
        pub(crate) samples: SkipSamples,
    }

    #[derive(Deserialize)]
    pub(crate) struct SkipSamples {
        pub(crate) skipped: Vec<String>,
        pub(crate) listed: Vec<String>,
    }

    #[derive(Deserialize)]
    pub(crate) struct Projects {
        pub(crate) made: Vec<Made>,
        pub(crate) imported: Vec<String>,
        pub(crate) refused: Vec<String>,
    }

    #[derive(Deserialize)]
    pub(crate) struct Made {
        pub(crate) slug: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Lines {
        from_sidecar: Vec<String>,
        from_rust: Vec<String>,
        bad: Vec<String>,
    }

    pub(crate) fn contract() -> Contract {
        serde_json::from_str(include_str!("../../sidecar/test/fixtures/contract.json")).expect("the contract fixture")
    }

    #[test]
    fn rust_starts_the_sidecar_as_the_contract_says() {
        let contract = contract();
        assert_eq!(BINARY, contract.binary);
        assert_eq!([APP_VERSION_FLAG, DATA_FLAG, PROJECTS_FLAG], [contract.flags.app_version, contract.flags.data, contract.flags.projects]);
        assert_eq!(STORE_FOLDER, contract.folders.store);
        assert_eq!(["PATH"].into_iter().chain(PASSED_ENV).collect::<Vec<_>>(), contract.env);
        assert_eq!([EXIT_DONE, EXIT_STORE_IN_USE], [contract.exit.done, contract.exit.store_in_use]);
        let samples = &contract.engine_events;
        let detail = |i: usize| samples[i]["detail"].as_str().expect("a detail").to_owned();
        let events = [EngineEvent { state: EngineState::Restarting, detail: detail(0) }, EngineEvent { state: EngineState::Stopped, detail: detail(1) }]
            .map(|event| serde_json::to_value(event).expect("json"));
        assert_eq!(events.to_vec(), *samples);
    }

    #[test]
    fn the_sidecars_binary_has_one_name_in_the_build_and_the_bundle() {
        let binary = contract().binary;
        assert!(include_str!("../../scripts/build-sidecar.sh").contains(&format!("\"$root/src-tauri/binaries/{binary}-$triple\"")));
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(config["bundle"]["externalBin"], json!([format!("binaries/{binary}")]));
    }

    #[test]
    fn rust_writes_the_lines_the_sidecar_reads() {
        let written = [
            Inbound::Call { id: 1, method: "app.ping", params: &json!({}) }.line(),
            Inbound::Call { id: 2, method: "nope", params: &json!({}) }.line(),
            Inbound::answer(1, Ok(json!({ "secret": null }))).line(),
            Inbound::answer(2, Err("locked".to_owned())).line(),
        ];
        let parse = |line: &str| serde_json::from_str::<Value>(line).expect("json");
        assert!(written.iter().all(|line| line.ends_with('\n') && line.matches('\n').count() == 1), "{written:?}");
        assert_eq!(written.map(|line| parse(&line)).to_vec(), contract().lines.from_rust.iter().map(|line| parse(line)).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn rust_reads_every_line_the_sidecar_writes_and_drops_a_bad_one() {
        let contract = contract();
        let app = mock_app();
        let (answers, _lines) = mpsc::unbounded_channel::<String>();
        let (heard, mut events) = mpsc::unbounded_channel::<String>();
        app.listen_any(EVENT, move |event| heard.send(event.payload().to_owned()).expect("the test listens"));
        let mut ready = Vec::new();
        for line in &contract.lines.from_sidecar {
            let message = serde_json::from_str::<Outbound>(line).unwrap_or_else(|e| panic!("{line}: {e}"));
            if matches!(message, Outbound::Event { .. }) {
                ready.push(dispatch(app.handle(), 0, &answers.downgrade(), line));
            }
        }
        assert_eq!(ready, [true, false], "only the first event is the ready one");
        for line in &contract.lines.bad {
            assert!(serde_json::from_str::<Outbound>(line).is_err(), "{line}");
            assert!(!dispatch(app.handle(), 0, &answers.downgrade(), line), "{line}");
        }
        let mut next = async || serde_json::from_str::<Value>(&events.recv().await.expect("an event")).expect("json")["type"].clone();
        assert_eq!([next().await, next().await], [json!("ready"), json!("login")]);
        assert!(events.try_recv().is_err(), "a bad line reaches no one");
    }

    #[tokio::test]
    async fn rust_answers_every_host_request_the_sidecar_makes() {
        let app = mock_app();
        for method in contract().host_requests {
            let refused = ask(&app, &method, Value::Null).await.expect_err("no params");
            assert!(refused.starts_with(&format!("bad params for {method}: ")), "{refused}");
        }
    }

    #[test]
    fn the_sidecar_starts_with_none_of_the_persons_agent_settings() {
        let names: Vec<&str> = kept_env().into_iter().map(|(name, _)| name).collect();
        assert!(names.contains(&"PATH"));
        assert!(names.iter().all(|name| ["PATH", "HOME", "USER", "LANG", "TMPDIR"].contains(name)), "{names:?}");
    }

    /// A slice that outlives its sidecar run keeps the update off until it ends, and none starts while one installs.
    #[tokio::test]
    async fn work_under_its_own_pass_holds_an_update_until_it_ends() {
        const SETTLE: Duration = Duration::from_millis(50);
        let gate = Arc::new(BuildGate::default());
        let sidecar = Sidecar::default();
        set_busy(&sidecar, &gate, 0, true).expect("the sidecar takes the pass");
        let (finish, finished) = oneshot::channel::<()>();
        let pass = take_pass(gate.clone());
        let slice = tokio::spawn(async move {
            let _pass = pass?;
            finished.await.map_err(|e| e.to_string())
        });
        tokio::time::sleep(SETTLE).await;
        sidecar.run_ended();
        let mut close = std::pin::pin!(gate.close_when_idle(|_| {}));
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "the update waits for the slice its sidecar left");
        finish.send(()).expect("the slice is still running");
        slice.await.expect("the slice task").expect("the slice");
        let closed = tokio::time::timeout(SETTLE, &mut close).await.expect("the update goes ahead once the slice ends");
        let refused = take_pass(gate.clone()).map(drop).expect_err("no slice starts while the update installs");
        assert!(refused.contains("update is installing"), "{refused}");
        drop(closed);
    }

    /// The pass a busy sidecar takes holds an update off until it gives it back, and while the update installs
    /// the pass, and with it a send, is refused.
    #[tokio::test]
    async fn an_update_waits_for_a_busy_sidecar_and_refuses_it_work_while_it_installs() {
        const SETTLE: Duration = Duration::from_millis(50);
        let gate = Arc::new(BuildGate::default());
        let sidecar = Sidecar::default();
        let run = sidecar.run_started();
        set_busy(&sidecar, &gate, run, true).expect("the sidecar takes the pass");
        set_busy(&sidecar, &gate, run, true).expect("asking again while it holds the pass changes nothing");
        let mut close = std::pin::pin!(gate.close_when_idle(|_| {}));
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "the update waits while the sidecar is busy");
        set_busy(&sidecar, &gate, run, false).expect("the sidecar gives the pass back");
        let closed = tokio::time::timeout(SETTLE, &mut close).await.expect("the update goes ahead once the sidecar is idle");
        let refused = set_busy(&sidecar, &gate, run, true).expect_err("work is refused while the update installs");
        assert!(refused.contains("update is installing"), "{refused}");
        drop(closed);
        set_busy(&sidecar, &gate, run, true).expect("a failed install lets the sidecar work again");
    }

    /// A busy request from a sidecar that already exited, answered after its exit gave the pass back, takes
    /// nothing, so an idle replacement never leaves an update waiting.
    #[tokio::test]
    async fn a_sidecar_that_exited_cannot_take_the_pass() {
        let gate = Arc::new(BuildGate::default());
        let sidecar = Sidecar::default();
        let exited = sidecar.run_started();
        sidecar.run_ended();
        let _replacement = sidecar.run_started();
        set_busy(&sidecar, &gate, exited, true).expect_err("the exited sidecar's request is refused");
        let close = gate.close_when_idle(|_| {});
        let _closed = tokio::time::timeout(Duration::from_millis(50), close).await.expect("the update goes ahead");
    }

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        crate::credentials::tests::use_test_store();
        let app = tauri::test::mock_app();
        app.manage(Sidecar::default());
        app.manage(Slices::default());
        app.manage(Arc::new(BuildGate::default()));
        app
    }

    async fn ask(app: &tauri::App<tauri::test::MockRuntime>, method: &str, params: Value) -> Result<Value, String> {
        let run = app.state::<Sidecar>().run_started();
        answer(app.handle(), run, method, params).await
    }

    /// The test store keeps a secret only in the entry that set it, so a get after a set finds nothing.
    #[tokio::test]
    async fn the_host_answers_keychain_requests_for_inference_items_only() {
        let app = mock_app();
        assert_eq!(ask(&app, "keychain.set", json!({ "account": "anthropic", "secret": "s" })).await, Ok(Value::Null));
        assert_eq!(ask(&app, "keychain.get", json!({ "account": "anthropic" })).await, Ok(json!({ "secret": null })));
        assert_eq!(ask(&app, "keychain.delete", json!({ "account": "anthropic" })).await, Ok(Value::Null));
        assert_eq!(ask(&app, "keychain.get", json!({ "account": "../printer" })).await, Err(r#""../printer" is not a provider account"#.to_owned()));
        assert_eq!(ask(&app, "keychain.delete", json!({ "account": "Anthropic" })).await, Err(r#""Anthropic" is not a provider account"#.to_owned()));
        let locked = keyring::Error::PlatformFailure("locked".into());
        assert_eq!(
            ask(&app, "keychain.get", json!({ "account": "fails.call" })).await,
            Err(format!("keyring get_password error for key=inference.fails.call: {locked}"))
        );
        let refused = ask(&app, "keychain.set", json!({ "account": "anthropic" })).await.expect_err("a set needs its secret");
        assert!(refused.starts_with("bad params for keychain.set: "), "{refused}");
    }

    #[tokio::test]
    async fn the_host_holds_the_update_pass_while_the_sidecar_says_it_is_busy() {
        const SETTLE: Duration = Duration::from_millis(50);
        let app = mock_app();
        let gate = app.state::<Arc<BuildGate>>().inner().clone();
        assert_eq!(ask(&app, "busy", json!({ "busy": true })).await, Ok(Value::Null));
        let mut close = std::pin::pin!(gate.close_when_idle(|_| {}));
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "the update waits while the sidecar is busy");
        assert_eq!(ask(&app, "busy", json!({ "busy": false })).await, Ok(Value::Null));
        drop(tokio::time::timeout(SETTLE, &mut close).await.expect("the update goes ahead once the sidecar is idle"));
        let refused = ask(&app, "busy", json!({ "busy": "yes" })).await.expect_err("busy is a bool");
        assert!(refused.starts_with("bad params for busy: "), "{refused}");
        let ended = app.state::<Sidecar>().run_started();
        app.state::<Sidecar>().run_ended();
        assert_eq!(answer(app.handle(), ended, "busy", json!({ "busy": true })).await, Err("This engine has exited.".to_owned()));
    }

    #[tokio::test]
    async fn the_host_reads_slice_params_before_the_pass_and_keeps_no_result_for_a_refused_slice() {
        let app = mock_app();
        let printer = json!({ "machine": "Bambu Lab P2S 0.4 nozzle", "process": "0.20mm Standard @BBL P2S", "filament": "Bambu PETG Basic @BBL P2S 0.4 nozzle" });
        let refused = ask(&app, "printer.check", json!({ "machine": 1 })).await.expect_err("a check needs a printer");
        assert!(refused.starts_with("bad params for printer.check: "), "{refused}");
        let gate = app.state::<Arc<BuildGate>>().inner().clone();
        let closed = gate.close_when_idle(|_| {}).await;
        let unnamed = json!({ "project": "p", "inputs": ["a.stl"], "output": "out.3mf", "printer": printer });
        let refused = ask(&app, "slice", unnamed).await.expect_err("a slice needs its operation id");
        assert!(refused.starts_with("bad params for slice: "), "{refused}");
        let call = json!({ "operation": "abc", "project": "p", "inputs": ["a.stl"], "output": "out.3mf", "printer": printer });
        let refused = ask(&app, "slice", call).await.expect_err("no slice starts while an update installs");
        assert!(refused.contains("update is installing"), "{refused}");
        assert!(!app.state::<Slices>().0.lock().expect("slices").contains_key("abc"), "the refusal is not kept as the slice's result");
        drop(closed);
        assert_eq!(ask(&app, "nope", Value::Null).await, Err("no host request nope".to_owned()));
    }

    /// A resumed turn's slice request waits for the first slice's result, and holds its own pass until it has it.
    #[tokio::test]
    async fn a_slice_request_holds_its_pass_until_its_slice_ends() {
        const SETTLE: Duration = Duration::from_millis(50);
        let app = mock_app();
        let first = Arc::new(tokio::sync::OnceCell::new());
        app.state::<Slices>().0.lock().expect("slices").insert("abc".to_owned(), first.clone());
        let (finish, finished) = oneshot::channel::<()>();
        let slicing = tokio::spawn(async move {
            first
                .get_or_init(|| async {
                    finished.await.expect("the test ends the slice");
                    Ok(json!("sliced"))
                })
                .await
                .clone()
        });
        tokio::time::sleep(SETTLE).await;
        let printer = json!({ "machine": "Bambu Lab P2S 0.4 nozzle", "process": "0.20mm Standard @BBL P2S", "filament": "Bambu PETG Basic @BBL P2S 0.4 nozzle" });
        let call = json!({ "operation": "abc", "project": "p", "inputs": ["a.stl"], "output": "out.3mf", "printer": printer });
        let mut request = std::pin::pin!(ask(&app, "slice", call));
        assert!(tokio::time::timeout(SETTLE, &mut request).await.is_err(), "the request waits for the first slice");
        let gate = app.state::<Arc<BuildGate>>().inner().clone();
        let mut close = std::pin::pin!(gate.close_when_idle(|_| {}));
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "the update waits for the slice request");
        finish.send(()).expect("the slice is still running");
        assert_eq!(request.await, Ok(json!("sliced")));
        assert_eq!(slicing.await.expect("the slice task"), Ok(json!("sliced")));
        drop(tokio::time::timeout(SETTLE, &mut close).await.expect("the update goes ahead once the slice request ends"));
    }

    #[tokio::test]
    async fn a_reply_settles_its_call() {
        let app = mock_app();
        let (answers, _lines) = mpsc::unbounded_channel::<String>();
        let call = |id| {
            let (reply, replied) = oneshot::channel();
            app.state::<Sidecar>().calls.lock().expect("calls").insert(id, reply);
            replied
        };
        let (listed, refused, bare) = (call(1), call(2), call(3));
        for line in [
            r#"{"kind":"reply","id":1,"ok":true,"value":{"chats":[]}}"#,
            r#"{"kind":"reply","id":2,"ok":false,"error":"no method x"}"#,
            r#"{"kind":"reply","id":3,"ok":false}"#,
            r#"{"kind":"reply","id":9,"ok":true}"#,
        ] {
            assert!(!dispatch(app.handle(), 0, &answers.downgrade(), line), "{line}");
        }
        assert_eq!(listed.await.expect("replied"), Ok(json!({ "chats": [] })));
        assert_eq!(refused.await.expect("replied"), Err("no method x".to_owned()));
        assert_eq!(bare.await.expect("replied"), Err("The engine refused the call.".to_owned()));
        assert!(app.state::<Sidecar>().calls.lock().expect("calls").is_empty());
    }

    #[tokio::test]
    async fn events_reach_the_window_and_only_ready_says_the_sidecar_is_ready() {
        let app = mock_app();
        let (answers, _lines) = mpsc::unbounded_channel::<String>();
        let (heard, mut events) = mpsc::unbounded_channel::<String>();
        app.listen_any(EVENT, move |event| heard.send(event.payload().to_owned()).expect("the test listens"));
        assert!(dispatch(app.handle(), 0, &answers.downgrade(), r#"{"kind":"event","event":{"type":"ready"}}"#));
        assert!(!dispatch(app.handle(), 0, &answers.downgrade(), r#"{"kind":"event","event":{"type":"chat","seq":2}}"#));
        assert!(!dispatch(app.handle(), 0, &answers.downgrade(), "not a protocol line"));
        assert!(!dispatch(app.handle(), 0, &answers.downgrade(), r#"{"kind":"mystery"}"#));
        let mut next = async || serde_json::from_str::<Value>(&events.recv().await.expect("an event")).expect("json");
        assert_eq!(next().await, json!({ "type": "ready" }));
        assert_eq!(next().await, json!({ "type": "chat", "seq": 2 }));
    }

    #[tokio::test]
    async fn a_request_is_answered_on_the_sidecars_input() {
        let app = mock_app();
        let (answers, mut lines) = mpsc::unbounded_channel::<String>();
        let run = app.state::<Sidecar>().run_started();
        assert!(!dispatch(app.handle(), run, &answers.downgrade(), r#"{"kind":"request","id":7,"method":"busy","params":{"busy":false}}"#));
        assert!(!dispatch(app.handle(), run, &answers.downgrade(), r#"{"kind":"request","id":8,"method":"nope","params":null}"#));
        let mut got = Vec::new();
        for _ in 0..2 {
            let line = lines.recv().await.expect("an answer");
            got.push(serde_json::from_str::<Value>(line.strip_suffix('\n').expect("one line")).expect("json"));
        }
        got.sort_by_key(|answer| answer["id"].as_u64());
        assert_eq!(
            got,
            [
                json!({ "kind": "answer", "id": 7, "ok": true, "value": null }),
                json!({ "kind": "answer", "id": 8, "ok": false, "error": "no host request nope" }),
            ]
        );
    }

    #[tokio::test]
    async fn a_call_from_the_window_goes_out_as_one_line_and_its_reply_comes_back() {
        let app = mock_app();
        let (input, mut lines) = mpsc::unbounded_channel::<String>();
        let answers = input.downgrade();
        app.state::<Sidecar>().link.send_replace(Link::Up(input));
        let reply = async {
            let line = lines.recv().await.expect("the call's line");
            let call: Value = serde_json::from_str(line.strip_suffix('\n').expect("one line")).expect("json");
            assert_eq!((&call["kind"], &call["method"], &call["params"]), (&json!("call"), &json!("chats.list"), &json!({ "all": true })));
            assert!(!dispatch(app.handle(), 0, &answers, &json!({ "kind": "reply", "id": call["id"], "ok": true, "value": [1] }).to_string()));
        };
        let (value, ()) = tokio::join!(super::sidecar(app.state(), "chats.list".to_owned(), json!({ "all": true })), reply);
        assert_eq!(value, Ok(json!([1])));
    }

    #[tokio::test]
    async fn a_call_the_engine_never_answers_fails_and_asks_to_try_again() {
        let restarted = Err::<Value, String>("The engine restarted before it answered. Try again.".to_owned());
        let app = mock_app();
        let (input, lines) = mpsc::unbounded_channel::<String>();
        drop(lines);
        app.state::<Sidecar>().link.send_replace(Link::Up(input));
        assert_eq!(super::sidecar(app.state(), "chats.list".to_owned(), Value::Null).await, restarted, "the line could not be queued");
        assert!(app.state::<Sidecar>().calls.lock().expect("calls").is_empty());

        let (input, mut lines) = mpsc::unbounded_channel::<String>();
        app.state::<Sidecar>().link.send_replace(Link::Up(input));
        let exit = async {
            lines.recv().await.expect("the call's line");
            app.state::<Sidecar>().drop_calls();
        };
        let (value, ()) = tokio::join!(super::sidecar(app.state(), "chats.list".to_owned(), Value::Null), exit);
        assert_eq!(value, restarted, "the sidecar exited before it answered");

        app.state::<Sidecar>().link.send_replace(Link::Stopped("Materialize 3D is quitting.".to_owned()));
        assert_eq!(super::sidecar(app.state(), "chats.list".to_owned(), Value::Null).await, Err("Materialize 3D is quitting.".to_owned()));
    }

    #[test]
    fn the_sidecar_keeps_the_persons_path_and_home() {
        let env: HashMap<&str, String> = kept_env().into_iter().collect();
        let current = std::env::var("PATH").expect("the test has a PATH");
        assert!(env["PATH"].ends_with(&current), "the login shell's folders come first: {}", env["PATH"]);
        assert_eq!(env.get("HOME"), std::env::var("HOME").ok().as_ref());
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
