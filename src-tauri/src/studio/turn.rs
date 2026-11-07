//! One chat turn: a `claude -p` run in the project folder whose stream-json
//! events go to the window and into the project's transcript.

use std::collections::{BTreeSet, HashMap};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::{files, lean, lean_session, project_dir, read_meta, META_DIR};
use crate::fabrication::build_gate::{BuildGate, OwnedRunning};
use crate::state::AppState;

const SYSTEM_PROMPT: &str = include_str!("system_prompt.md");
const MODEL: &str = "claude-opus-5-5";
pub const EVENT: &str = "studio://event";

/// The variable each agent runs with, which its tools inherit. A reopen after a
/// crash finds what a turn left by this tag, because the agent that started the
/// tools is gone by then.
const TAG_VAR: &str = "M3D_TURN";

/// A running turn: Stop cancels it, and quitting the app ends its processes.
struct Turn {
    token: CancellationToken,
    tag: String,
    /// The agent's pid while it is unreaped, 0 before it starts and after. The
    /// turn takes this lock to clear it before reaping, and quitting holds it
    /// while ending the turn, so the pid is never used after it could be reused.
    leader: Arc<Mutex<u32>>,
}

/// The running turn of each project, so a second send waits and Stop can end it.
#[derive(Default)]
pub struct Turns(Mutex<HashMap<String, Turn>>);

impl Turns {
    /// Ends every running agent and its tools. Called as the app exits, when
    /// there is no time left to wait on the turns' own tasks.
    pub fn stop_all(&self) {
        let Ok(running) = self.0.lock() else { return };
        let tags: Vec<String> = running.values().inspect(|turn| turn.token.cancel()).map(|turn| turn.tag.clone()).collect();
        // Held until the end, so no turn reaps its agent while its pid is in use here.
        let leaders: Vec<_> = running.values().filter_map(|turn| turn.leader.lock().ok()).collect();
        let pids: Vec<u32> = leaders.iter().map(|leader| **leader).collect();
        end_turn(&pids, &tags, &BTreeSet::new());
    }

    /// The groups of every running agent but this project's, which this turn must never signal.
    fn other_agents(&self, project: &str) -> BTreeSet<i32> {
        let Ok(running) = self.0.lock() else { return BTreeSet::new() };
        running
            .iter()
            .filter(|(name, _)| name.as_str() != project)
            .filter_map(|(_, turn)| turn.leader.lock().ok().map(|pid| *pid as i32))
            .filter(|&group| group > 0)
            .collect()
    }
}

/// One process in a `ps` reading.
#[cfg(unix)]
struct Process {
    pid: i32,
    parent: i32,
    group: i32,
    /// False for a process that has exited but is not yet reaped (a zombie).
    running: bool,
}

/// Every process, with its parent and group. `ps` shows these for every process,
/// the system's own programs included.
#[cfg(unix)]
fn processes() -> Vec<Process> {
    let Ok(out) = std::process::Command::new("ps").args(["-axo", "pid=,ppid=,pgid=,stat="]).output() else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            Some(Process {
                pid: words.next()?.parse().ok()?,
                parent: words.next()?.parse().ok()?,
                group: words.next()?.parse().ok()?,
                running: !words.next()?.starts_with('Z'),
            })
        })
        .collect()
}

/// The process groups that hold a process carrying one of these turn tags.
/// macOS hides the environment of its own programs (sh, bash, zsh, sleep, tail),
/// so there only tools such as python, uv, node, and Bambu Studio are found this way.
#[cfg(unix)]
fn tagged_groups(tags: &[String]) -> Vec<i32> {
    if tags.is_empty() {
        return Vec::new();
    }
    let args: &[&str] = if cfg!(target_os = "macos") { &["-axE", "-ww", "-o", "pgid=,command="] } else { &["axeww", "-o", "pgid=,command="] };
    let Ok(out) = std::process::Command::new("ps").args(args).output() else { return Vec::new() };
    let marks: Vec<String> = tags.iter().map(|tag| format!("{TAG_VAR}={tag}")).collect();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        // A whole word, as `ps` prints each variable, not any text that contains it.
        .filter(|line| line.split_whitespace().any(|word| marks.iter().any(|mark| word == mark)))
        .filter_map(|line| line.split_whitespace().next()?.parse().ok())
        .collect()
}

/// The groups of these agents and of every process under them. This covers a
/// shell tool that Claude Code started in a group of its own, whose environment
/// macOS hides. Only safe while each leader is unreaped.
#[cfg(unix)]
fn tree_groups(table: &[Process], leaders: &[u32]) -> BTreeSet<i32> {
    let mut tree: BTreeSet<i32> = leaders.iter().filter(|&&pid| pid > 0).map(|&pid| pid as i32).collect();
    loop {
        let more: Vec<i32> = table.iter().filter(|p| tree.contains(&p.parent) && !tree.contains(&p.pid)).map(|p| p.pid).collect();
        if more.is_empty() {
            break;
        }
        tree.extend(more);
    }
    table.iter().filter(|p| tree.contains(&p.pid)).map(|p| p.group).collect()
}

/// Ends a turn's processes: SIGTERM to every group it owns, then SIGKILL after
/// three seconds to whatever still runs. A group is the turn's when it is in the
/// agent's live tree or holds a process with the turn's tag, and never when it is
/// the app's group or in `exclude` (other turns' agents). The tree is read before
/// any signal, while every leader is unreaped, so a tool that loses its agent
/// stays on the list. Blocking: for Stop, the end of every turn, the app's exit,
/// and a reopen after a crash.
///
/// Known limits (issue #192), because macOS gives an app no way to own a process tree: a tool
/// Claude Code leaves running when it exits by itself, and a tool that survives a
/// crash of both the app and the agent, are found only by their tag, and macOS
/// hides the tag of its own programs (sh, bash, zsh, sleep, tail).
fn end_turn(leaders: &[u32], tags: &[String], exclude: &BTreeSet<i32>) {
    #[cfg(unix)]
    {
        // SAFETY: getpgrp only reads this process's own group.
        let own = unsafe { libc::getpgrp() };
        let ours = |group: &i32| *group > 1 && *group != own && !exclude.contains(group);
        let read = |table: &[Process]| -> BTreeSet<i32> { tree_groups(table, leaders).into_iter().chain(tagged_groups(tags)).filter(ours).collect() };
        // A group that is already gone is the outcome we want, so the result is not read.
        let signal = |groups: &mut dyn Iterator<Item = i32>, sig: libc::c_int| {
            for group in groups {
                // SAFETY: killpg only signals a group this turn owns.
                let _ = unsafe { libc::killpg(group, sig) };
            }
        };
        let table = processes();
        if table.is_empty() {
            // No `ps` to read: end at least each agent's own group, whose pid is still its own.
            signal(&mut leaders.iter().map(|&pid| pid as i32).filter(ours), libc::SIGTERM);
            return;
        }
        let mut known = read(&table);
        if known.is_empty() {
            return;
        }
        signal(&mut known.iter().copied(), libc::SIGTERM);
        for _ in 0..30 {
            let table = processes();
            let fresh = read(&table);
            signal(&mut fresh.difference(&known).copied(), libc::SIGTERM);
            known.extend(fresh);
            if !table.iter().any(|p| p.running && known.contains(&p.group)) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let table = processes();
        signal(&mut known.iter().copied().filter(|group| table.iter().any(|p| p.running && p.group == *group)), libc::SIGKILL);
    }
}

/// Waits up to five seconds for an agent whose output ended to exit by itself,
/// without reaping it, so its pid stays its own while the turn is ended.
#[cfg(unix)]
fn wait_for_exit(pid: u32) {
    for _ in 0..50 {
        if !processes().iter().any(|p| p.pid == pid as i32 && p.running) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Names the running turn's tag while it runs, so a reopen after a crash can find what it left.
fn tag_path(dir: &Path) -> PathBuf {
    dir.join(META_DIR).join("agent.turn")
}

/// After a crash, an agent or its tools can outlive the app. The tag file names
/// the turn, and every process still carrying that tag is stopped. The agent is
/// gone by then, so its process tree cannot be walked. Known limit: a tool that
/// clears its environment, or on macOS a group made only of the system's own
/// programs (sh, bash, zsh, sleep), shows no tag and survives a crash of both
/// the app and the agent. Stop, the end of a turn, and quitting the app read the
/// live tree instead, so they end those tools.
fn stop_survivor(dir: &Path) {
    let path = tag_path(dir);
    // Only a whole tag counts. Anything else could match other turns' processes.
    let tag = std::fs::read_to_string(&path).ok().and_then(|text| uuid::Uuid::parse_str(text.trim()).ok());
    if let Some(tag) = tag {
        log::warn!("studio: stopping processes left from a turn before the app closed");
        end_turn(&[], &[tag.to_string()], &BTreeSet::new());
    }
    let _ = std::fs::remove_file(&path);
}

fn transcript_path(dir: &Path) -> PathBuf {
    dir.join(META_DIR).join("transcript.jsonl")
}

/// Reads the transcript. A last line without its newline is a write still in
/// progress, or one the app never finished because it stopped. Readers skip it.
/// The one writer (`repair`) cuts it off: the turn that owns the file, or the
/// reconcile when no turn runs.
fn read_transcript(dir: &Path, repair: bool) -> Result<Vec<Value>, String> {
    let path = transcript_path(dir);
    // Bytes first: a write cut inside a multibyte character is not valid UTF-8 until it is cut off.
    let mut bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if bytes.last().is_some_and(|&b| b != b'\n') {
        bytes.truncate(bytes.iter().rposition(|&b| b == b'\n').map_or(0, |end| end + 1));
        if repair {
            std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    let text = String::from_utf8(bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    text.lines().map(|line| serde_json::from_str(line).map_err(|e| format!("{}: {e}", path.display()))).collect()
}

/// The project's transcript, one JSON event per line. A line's index is its
/// `seq`, which lets the window join a loaded history with live events without
/// a gap or a repeat.
struct Transcript {
    dir: PathBuf,
    next: usize,
}

impl Transcript {
    fn open(dir: &Path) -> Result<Self, String> {
        Ok(Self { dir: dir.to_owned(), next: read_transcript(dir, true)?.len() })
    }

    fn write(&mut self, event: &Value) -> Result<usize, String> {
        let path = transcript_path(&self.dir);
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        writeln!(file, "{event}").map_err(|e| format!("{}: {e}", path.display()))?;
        self.next += 1;
        Ok(self.next - 1)
    }

    /// Writes the event, then sends it to the window with its `seq`.
    fn record(&mut self, app: &AppHandle, project: &str, event: Value) -> Result<(), String> {
        let seq = self.write(&event)?;
        let _ = app.emit(EVENT, json!({ "project": project, "seq": seq, "event": event }));
        Ok(())
    }
}

/// A turn whose user message has no end event was cut off when the app closed.
fn has_open_turn(events: &[Value]) -> bool {
    events.iter().fold(false, |open, event| match event["type"].as_str() {
        Some("m3d_user") => true,
        Some("m3d_turn_end") => false,
        _ => open,
    })
}

/// Everything said in the project so far, in order. A turn the app was closed
/// during is ended here, so the chat never waits on a process that is gone.
#[tauri::command]
pub fn studio_transcript(turns: State<'_, Turns>, project: String) -> Result<Vec<Value>, String> {
    let dir = project_dir(&project)?;
    let running = turns.0.lock().map_err(|e| e.to_string())?;
    let idle = !running.contains_key(&project);
    let mut events = read_transcript(&dir, idle)?;
    if idle && has_open_turn(&events) {
        stop_survivor(&dir);
        let end = json!({ "type": "m3d_turn_end", "ok": false, "error": "This turn stopped when the app closed." });
        Transcript { dir, next: events.len() }.write(&end)?;
        events.push(end);
    }
    Ok(events)
}

/// The app's data folder, or a verification run's own.
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(dir) = std::env::var_os("M3D_E2E_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    app.path().app_data_dir().map_err(|e| format!("app data folder: {e}"))
}

/// How long the login shell may take to tell its PATH before the app goes on without it.
const LOGIN_SHELL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// The PATH of the person's login shell. An app opened from Finder starts with
/// only the system folders, where `claude`, `codex`, and `uv` are not.
pub(crate) fn login_path() -> &'static str {
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
    // The shell leads a process group of its own, so the deadline ends what its startup files started too.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (sent, said) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut out);
        let _ = sent.send(out);
    });
    let out = said.recv_timeout(deadline).ok();
    // Startup files can send stdout elsewhere and go on running, so the shell's end has the same deadline.
    let ended = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if std::time::Instant::now() < end => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => break false,
        }
    };
    if !ended {
        #[cfg(unix)]
        if let Ok(group) = i32::try_from(child.id()) {
            // SAFETY: killpg only sends a signal, to the group this shell leads and has not been reaped from.
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    let out = out?;
    String::from_utf8_lossy(&out).rsplit_once(marker).map(|(_, path)| path.trim().to_owned()).filter(|path| !path.is_empty())
}

/// The image the model gets for a picture in `refs/`. Claude reads JPEG, PNG,
/// GIF, and WebP up to about 5 MB, so on macOS a HEIC photo or a large one is
/// sent as a smaller JPEG made with `sips`. The original stays in `refs/`.
fn image_block(dir: &Path, rel: &str) -> Result<Value, String> {
    let path = dir.join(rel);
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    let size = std::fs::metadata(&path).map_err(|e| format!("{rel}: {e}"))?.len();
    let readable = matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp");
    let send_path = if cfg!(target_os = "macos") && (!readable || size > 3_500_000) {
        let out = dir.join(META_DIR).join("send").join(format!("{}.jpg", rel.replace('/', "_")));
        std::fs::create_dir_all(out.parent().expect("has parent")).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("sips")
            .args(["-s", "format", "jpeg", "-Z", "2000"])
            .arg(&path)
            .arg("--out")
            .arg(&out)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("sips: {e}"))?;
        if !status.success() {
            return Err(format!("could not convert {rel} to JPEG"));
        }
        out
    } else if readable {
        path
    } else {
        return Err(format!("{rel} is not a JPEG, PNG, GIF, or WebP picture"));
    };
    let media_type = match send_path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    };
    let bytes = std::fs::read(&send_path).map_err(|e| format!("{}: {e}", send_path.display()))?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } }))
}

/// Hook chatter is noise in the chat; everything else is kept.
fn keep(event: &Value) -> bool {
    !(event["type"] == "system" && event["subtype"] != "init")
}

/// Starts a turn. Returns once the agent is running; its events arrive on
/// `studio://event` and end with `m3d_turn_end`.
#[tauri::command]
pub fn studio_send(app: AppHandle, turns: State<'_, Turns>, project: String, text: String, images: Vec<String>) -> Result<(), String> {
    let dir = project_dir(&project)?;
    let meta = lean_session(&dir, read_meta(&dir)?)?;
    let mut content: Vec<Value> = images.iter().map(|rel| image_block(&dir, rel)).collect::<Result<_, _>>()?;
    let mut prompt = text.clone();
    if !images.is_empty() {
        prompt.push_str(&format!("\n\n(Pictures attached, saved in this folder as: {})", images.join(", ")));
    }
    content.push(json!({ "type": "text", "text": prompt }));
    let message = json!({ "type": "user", "message": { "role": "user", "content": content } });

    // The agent's own environment: the person's inference login, the app's plugin, and nothing else of their setup.
    let home = dirs::home_dir().ok_or("no home folder")?;
    let inference = lean::ClaudeInference::read(&home)?;
    let plugin = app.path().resource_dir().map_err(|e| format!("app resources: {e}"))?.join("studio-plugin");
    let app_data = app_data_dir(&app)?;

    // Taken before anything is written and dropped after the last write, on every path.
    let pass = take_pass(app.state::<Arc<AppState>>().inner().clone())?;
    let token = CancellationToken::new();
    let tag = uuid::Uuid::new_v4().to_string();
    let leader = Arc::new(Mutex::new(0));
    {
        let mut running = turns.0.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&project) {
            return Err("The agent is still working on the last message.".to_owned());
        }
        running.insert(project.clone(), Turn { token: token.clone(), tag: tag.clone(), leader: leader.clone() });
    }
    // A turn that cannot write its first line never started, so it gives its place back.
    let mut transcript = match Transcript::open(&dir)
        .and_then(|mut t| t.record(&app, &project, json!({ "type": "m3d_user", "text": text, "images": images })).map(|()| t))
    {
        Ok(transcript) => transcript,
        Err(e) => {
            turns.0.lock().map_err(|e| e.to_string())?.remove(&project);
            return Err(e);
        }
    };

    let started = dir.join(META_DIR).join("session-started");
    let session_flag = if started.exists() { "--resume" } else { "--session-id" };
    let model = std::env::var("M3D_AGENT_MODEL").unwrap_or_else(|_| MODEL.to_owned());
    let mut command = tokio::process::Command::new("claude");
    command
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"])
        .args(["--model", &model, "--permission-mode", "bypassPermissions"])
        .args(["--append-system-prompt", SYSTEM_PROMPT])
        .args([session_flag, &meta.session_id])
        .args(inference.args(&plugin))
        .current_dir(&dir)
        // Only what the agent needs: a home, a shell, the locale, the login PATH,
        // the inference keys, and Astra's own home. Nothing else of the app's environment.
        .env_clear()
        .envs(lean::KEPT_ENV.iter().filter_map(|&key| std::env::var_os(key).map(|value| (key, value))))
        .env("PATH", login_path())
        .envs(inference.env.iter().map(|(key, value)| (key, value)))
        .envs(lean::NO_MEMORY_ENV)
        .env(TAG_VAR, &tag)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Its own process group, apart from the app's, so signals to it never reach the app.
    #[cfg(unix)]
    command.process_group(0);

    tauri::async_runtime::spawn(async move {
        let before: HashMap<String, u64> = files::list(&dir).unwrap_or_default().into_iter().map(|f| (f.rel.clone(), f.modified_ms)).collect();
        // Astra's home walks the person's skills folder, so it is made here, off the main thread.
        // If it cannot be made, Astra still gets the app's folder and so has no model, never the person's setup.
        let astra_dir = app_data.join("astra");
        let astra = tauri::async_runtime::spawn_blocking(move || lean::astra_home(&home, &app_data))
            .await
            .map_err(|e| format!("preparing Astra: {e}"))
            .and_then(|made| made)
            .unwrap_or_else(|error| {
                log::warn!("studio: {error}, so Astra cannot reach a model this turn");
                lean::AstraHome { dir: astra_dir, env: Vec::new(), secrets: Vec::new() }
            });
        let mut command = command;
        // Astra, the codex helper, finds its home through the agent's environment, plus the variables its provider reads.
        command
            .env("CODEX_HOME", &astra.dir)
            .envs(astra.env.iter().filter_map(|key| std::env::var_os(key).map(|value| (key, value))))
            .envs(astra.secrets.iter().map(|(key, value)| (key, value)));
        let outcome = run(&app, &project, &mut transcript, &started, command, message, token, &tag, &leader).await;
        let changed: Vec<String> = files::list(&dir)
            .unwrap_or_default()
            .into_iter()
            .filter(|f| before.get(&f.rel) != Some(&f.modified_ms) && !f.rel.starts_with("refs/"))
            .map(|f| f.rel)
            .collect();
        let mut events = Vec::new();
        if !changed.is_empty() {
            events.push(json!({ "type": "m3d_files", "files": changed }));
        }
        events.push(match outcome {
            Ok(()) => json!({ "type": "m3d_turn_end", "ok": true }),
            Err(error) => json!({ "type": "m3d_turn_end", "ok": false, "error": error }),
        });
        for event in events {
            if let Err(e) = transcript.record(&app, &project, event) {
                log::error!("studio: transcript write failed: {e}");
            }
        }
        if let Some(turns) = app.try_state::<Turns>() {
            if let Ok(mut running) = turns.0.lock() {
                running.remove(&project);
            }
        }
        // The turn's last line is written, so the updater may go ahead.
        drop(pass);
    });
    Ok(())
}

/// The gate inside the app's state, so a turn's pass can own its way to it.
struct StateGate(Arc<AppState>);

impl std::ops::Deref for StateGate {
    type Target = BuildGate;
    fn deref(&self) -> &BuildGate {
        &self.0.builds
    }
}

/// A turn's build pass. The updater restarts the app only once no build and no
/// turn holds one. A turn takes it before its first transcript line and drops it
/// after its last, so a restart never cuts a turn's work or its record short.
/// While an update installs, the gate is closed and a new turn is refused.
fn take_pass(state: Arc<AppState>) -> Result<OwnedRunning<StateGate>, String> {
    BuildGate::enter_owned(StateGate(state))
        .ok_or_else(|| "An update is installing, and the app restarts when it is done. Send this again after it opens.".to_owned())
}

async fn run(
    app: &AppHandle,
    project: &str,
    transcript: &mut Transcript,
    started: &Path,
    mut command: tokio::process::Command,
    message: Value,
    token: CancellationToken,
    tag: &str,
    leader: &Mutex<u32>,
) -> Result<(), String> {
    // Written before the agent starts and removed when this run ends, so a crash leaves it behind.
    let tag_file = tag_path(&transcript.dir);
    // Written whole or not at all, so a crash never leaves a partial tag.
    let staged = tag_file.with_extension("turn.new");
    std::fs::write(&staged, tag).and_then(|()| std::fs::rename(&staged, &tag_file)).map_err(|e| format!("{}: {e}", tag_file.display()))?;
    let _tag_file = RemoveOnDrop(tag_file);
    let mut child = command.spawn().map_err(|e| format!("could not start the claude CLI: {e}. Install Claude Code and sign in."))?;
    let pid = child.id().unwrap_or(0);
    *leader.lock().map_err(|e| e.to_string())? = pid;

    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let outcome = drive(app, project, transcript, started, &mut child, message, &token).await;

    // However the turn ended, nothing of it keeps running, and this happens before
    // the tag file goes. The agent is not reaped yet, so its pid is still its own.
    let finished = matches!(outcome, Ok(_));
    let exclude = app.try_state::<Turns>().map(|turns| turns.other_agents(project)).unwrap_or_default();
    let tags = vec![tag.to_owned()];
    let _ = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(unix)]
        if finished {
            wait_for_exit(pid);
        }
        end_turn(&[pid], &tags, &exclude);
    })
    .await;
    // Whatever the process reading found, the agent itself does not outlive its
    // turn. A kill without a wait leaves it unreaped, so its pid stays its own.
    let _ = child.start_kill();
    // Cleared before reaping, under the lock quitting holds while it ends turns,
    // so no one uses the pid once it could belong to someone else.
    if let Ok(mut pid) = leader.lock() {
        *pid = 0;
    }
    let status = child.wait().await.map_err(|e| format!("waiting for claude: {e}"));
    let result_error = outcome?;
    let status = status?;
    let stderr = stderr_task.await.unwrap_or_default();
    if let Some(error) = result_error {
        return Err(error);
    }
    if !status.success() {
        let tail: String = stderr.trim().chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(if tail.is_empty() { format!("claude exited with {status}") } else { tail });
    }
    Ok(())
}

/// Sends the message and records the agent's events until its output ends or
/// it is stopped. Returns the error the agent reported, if any. It never reaps
/// the agent: `run` does that after the turn's processes are ended.
async fn drive(
    app: &AppHandle,
    project: &str,
    transcript: &mut Transcript,
    started: &Path,
    child: &mut tokio::process::Child,
    message: Value,
    token: &CancellationToken,
) -> Result<Option<String>, String> {
    let mut stdin = child.stdin.take().expect("piped stdin");
    let line = format!("{message}\n");
    // A Stop or a quit that came while the agent was starting ends it here.
    tokio::select! {
        () = token.cancelled() => return Err("Stopped.".to_owned()),
        written = stdin.write_all(line.as_bytes()) => written.map_err(|e| format!("writing to claude: {e}"))?,
    }
    drop(stdin);

    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut result_error: Option<String> = None;
    loop {
        let line = tokio::select! {
            () = token.cancelled() => return Err("Stopped.".to_owned()),
            line = lines.next_line() => line.map_err(|e| format!("reading claude output: {e}"))?,
        };
        let Some(line) = line else { return Ok(result_error) };
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        if event["type"] == "system" && event["subtype"] == "init" {
            let _ = std::fs::write(started, b"");
        }
        if event["type"] == "result" && event["is_error"] == true {
            result_error = Some(event["result"].as_str().unwrap_or("The agent stopped with an error.").to_owned());
        }
        if keep(&event) {
            transcript.record(app, project, event)?;
        }
    }
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Stops the project's running turn.
#[tauri::command]
pub fn studio_cancel(turns: State<'_, Turns>, project: String) -> Result<(), String> {
    if let Some(turn) = turns.0.lock().map_err(|e| e.to_string())?.get(&project) {
        turn.token.cancel();
    }
    Ok(())
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

    const SETTLE: std::time::Duration = std::time::Duration::from_millis(50);

    /// The pass `studio_send` takes holds an update off until the turn drops it,
    /// and while the update installs a new turn is refused before it writes anything.
    #[tokio::test]
    async fn an_update_waits_for_a_turns_pass_and_a_turn_is_refused_while_it_installs() {
        let state = Arc::new(AppState::default());
        let pass = take_pass(state.clone()).expect("a turn starts");
        let mut close = std::pin::pin!(state.builds.close_when_idle(|_| {}));
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "the update waits while the turn holds its pass");
        drop(pass);
        let closed = tokio::time::timeout(SETTLE, &mut close).await.expect("the update goes ahead once the turn is done");
        let refused = take_pass(state.clone()).err().expect("a turn is refused while the update installs");
        assert!(refused.contains("update is installing"));
        drop(closed);
        assert!(take_pass(state.clone()).is_ok(), "a failed install lets turns start again");
    }

    #[test]
    fn a_reopened_transcript_numbers_lines_on_and_knows_an_unfinished_turn() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join(META_DIR)).expect("meta dir");
        let mut first = Transcript::open(dir.path()).expect("open");
        assert_eq!(first.write(&json!({ "type": "m3d_user", "text": "a clip" })).expect("write"), 0);
        assert_eq!(first.write(&json!({ "type": "assistant" })).expect("write"), 1);

        let mut reopened = Transcript::open(dir.path()).expect("reopen");
        assert!(has_open_turn(&read_transcript(dir.path(), false).expect("read")));
        assert_eq!(reopened.write(&json!({ "type": "m3d_turn_end", "ok": true })).expect("write"), 2);
        assert!(!has_open_turn(&read_transcript(dir.path(), false).expect("read")));
    }

    #[test]
    fn a_write_cut_off_by_a_crash_is_dropped_and_the_next_line_numbers_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join(META_DIR)).expect("meta dir");
        std::fs::write(transcript_path(dir.path()), "{\"type\":\"m3d_user\"}\n{\"type\":\"assi").expect("write");
        assert_eq!(read_transcript(dir.path(), false).expect("read").len(), 1);
        assert!(std::fs::read_to_string(transcript_path(dir.path())).expect("raw").ends_with("assi"), "a reader leaves a write in progress alone");
        let mut transcript = Transcript::open(dir.path()).expect("open");
        assert_eq!(transcript.write(&json!({ "type": "m3d_turn_end", "ok": false })).expect("write"), 1);
        assert_eq!(read_transcript(dir.path(), false).expect("read").len(), 2);
    }

    /// The Stop path, with no tag: the agent starts `sleep` in a group of its
    /// own, as Claude Code does for each tool. `sleep` is a system program,
    /// so on macOS only the walk of the live process tree can find it.
    #[cfg(unix)]
    #[test]
    fn a_shell_tool_in_its_own_group_is_ended_through_the_live_tree() {
        use std::os::unix::process::CommandExt as _;
        // perl, not `sh -c 'set -m'`: dash ignores job control without a terminal, so it never moves the tool.
        let mut agent = std::process::Command::new("perl")
            .args(["-e", r#"if (fork == 0) { setpgrp(0, 0); exec "sleep", "30" } wait"#])
            .process_group(0)
            .spawn()
            .expect("perl");
        let leader = agent.id();
        let tool = (0..50)
            .find_map(|_| {
                let found = processes().into_iter().find(|p| p.parent == leader as i32 && p.group == p.pid); // forked first, then moved to its own group
                if found.is_none() {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                found
            })
            .expect("the agent started its tool");
        assert_ne!(tool.group, leader as i32, "the tool runs in a group of its own");
        end_turn(&[leader], &[], &BTreeSet::new());
        let _ = agent.wait();
        // SAFETY: signal 0 only asks whether the process exists.
        let gone = (0..30).any(|_| unsafe { libc::kill(tool.pid, 0) } != 0 || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            false
        });
        assert!(gone, "the tool outside the agent's group was ended");
    }

    #[cfg(unix)]
    #[test]
    fn after_a_crash_a_tagged_tool_is_ended_and_an_untagged_one_is_not() {
        use std::os::unix::process::CommandExt as _;
        let tag = uuid::Uuid::new_v4().to_string();
        let spawn = |tagged: bool| {
            // python3, not sleep: macOS hides the environment of its own system programs such as sleep.
            let mut command = std::process::Command::new("python3");
            command.args(["-c", "import time; time.sleep(30)"]).process_group(0);
            if tagged {
                command.env(TAG_VAR, &tag);
            }
            command.spawn().expect("sleep")
        };
        let (mut tool, mut other) = (spawn(true), spawn(false));
        // `ps` shows a new process's environment only once it has started, which can lag the spawn.
        let seen = (0..50).any(|_| !tagged_groups(std::slice::from_ref(&tag)).is_empty() || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            false
        });
        assert!(seen, "ps never showed the tagged process");
        end_turn(&[], &[tag.clone()], &BTreeSet::new());
        assert!(tool.wait().expect("wait").code().is_none(), "the tagged tool was killed by a signal");
        assert!(other.try_wait().expect("try_wait").is_none(), "the untagged process still runs");
        other.kill().expect("kill");
        let _ = other.wait();
    }

    #[test]
    fn a_write_cut_inside_a_multibyte_character_is_dropped_too() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join(META_DIR)).expect("meta dir");
        let mut bytes = b"{\"type\":\"m3d_user\"}\n{\"text\":\"".to_vec();
        bytes.extend_from_slice(&"\u{8bbe}".as_bytes()[..2]);
        std::fs::write(transcript_path(dir.path()), bytes).expect("write");
        assert_eq!(read_transcript(dir.path(), false).expect("read").len(), 1);
        assert_eq!(Transcript::open(dir.path()).expect("open").next, 1);
    }
}
