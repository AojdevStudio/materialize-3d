//! One chat turn: a `claude -p` run in the project folder whose stream-json
//! events go to the window and into the project's transcript.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use super::{files, project_dir, read_meta, META_DIR};

const SYSTEM_PROMPT: &str = include_str!("system_prompt.md");
const MODEL: &str = "claude-opus-5-5";
pub const EVENT: &str = "studio://event";

/// The variable each agent runs with. Claude Code starts every tool in its own
/// process group, so the groups are found by this tag, which children inherit.
const TAG_VAR: &str = "M3D_TURN";

/// A running turn: Stop cancels it, and quitting the app ends its processes.
struct Turn {
    token: CancellationToken,
    tag: String,
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
        end_tagged(&tags);
    }
}

/// The process groups that hold a process carrying one of these turn tags.
/// `ps` shows the environment of the person's own processes, except that macOS
/// hides it for the system's own programs.
#[cfg(unix)]
fn tagged_groups(tags: &[String]) -> Vec<libc::pid_t> {
    let args: &[&str] = if cfg!(target_os = "macos") { &["-axE", "-ww", "-o", "pgid=,command="] } else { &["axeww", "-o", "pgid=,command="] };
    let Ok(out) = std::process::Command::new("ps").args(args).output() else { return Vec::new() };
    let marks: Vec<String> = tags.iter().map(|tag| format!("{TAG_VAR}={tag}")).collect();
    // SAFETY: getpgrp only reads this process's own group.
    let own = unsafe { libc::getpgrp() };
    let mut groups: Vec<libc::pid_t> = String::from_utf8_lossy(&out.stdout)
        .lines()
        // A whole word, as `ps` prints each variable, not any text that contains it.
        .filter(|line| line.split_whitespace().any(|word| marks.iter().any(|mark| word == mark)))
        .filter_map(|line| line.split_whitespace().next()?.parse().ok())
        .filter(|&group| group > 1 && group != own)
        .collect();
    groups.sort_unstable();
    groups.dedup();
    groups
}

/// Groups with a process that still runs. A process that has exited but is not
/// yet reaped (a zombie) no longer counts, so a stopped agent is not waited on.
#[cfg(unix)]
fn running_groups() -> std::collections::BTreeSet<libc::pid_t> {
    let Ok(out) = std::process::Command::new("ps").args(["-axo", "pgid=,stat="]).output() else { return Default::default() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            let group = words.next()?.parse().ok()?;
            (!words.next()?.starts_with('Z')).then_some(group)
        })
        .collect()
}

/// Asks every process of these turns to stop, waits up to three seconds, then
/// kills what is left. Blocking: for Stop, the app's exit, and a reopen after a crash.
fn end_tagged(tags: &[String]) {
    #[cfg(unix)]
    {
        if tags.is_empty() {
            return;
        }
        // A group that is already gone is the outcome we want, so the result is not read.
        let signal = |groups: &[libc::pid_t], sig: libc::c_int| {
            for &group in groups {
                // SAFETY: killpg only signals a group that holds a process this app tagged.
                let _ = unsafe { libc::killpg(group, sig) };
            }
        };
        // Every group seen stays on the list: a child can outlive the tagged process it came from.
        let mut known = std::collections::BTreeSet::new();
        known.extend(tagged_groups(tags));
        signal(&known.iter().copied().collect::<Vec<_>>(), libc::SIGTERM);
        let alive = |known: &std::collections::BTreeSet<libc::pid_t>| {
            let running = running_groups();
            known.iter().copied().filter(|group| running.contains(group)).collect::<Vec<_>>()
        };
        for _ in 0..30 {
            let fresh = tagged_groups(tags);
            signal(&fresh.iter().copied().filter(|group| !known.contains(group)).collect::<Vec<_>>(), libc::SIGTERM);
            known.extend(fresh);
            if alive(&known).is_empty() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        signal(&alive(&known), libc::SIGKILL);
    }
}

/// Names the running turn's tag while it runs, so a reopen after a crash can find what it left.
fn tag_path(dir: &Path) -> PathBuf {
    dir.join(META_DIR).join("agent.turn")
}

/// After a crash, an agent or its tools can outlive the app. The tag file names
/// the turn, and every process still carrying that tag is stopped. Two kinds of
/// tool are not found here: one that clears its own environment, and on macOS a
/// group made only of the system's own programs (sh, sleep), whose environment
/// macOS hides. The agent and the tools a job runs (python, uv, node, Bambu
/// Studio) show their tag.
fn stop_survivor(dir: &Path) {
    let path = tag_path(dir);
    // Only a whole tag counts. Anything else could match other turns' processes.
    let tag = std::fs::read_to_string(&path).ok().and_then(|text| uuid::Uuid::parse_str(text.trim()).ok());
    if let Some(tag) = tag {
        log::warn!("studio: stopping processes left from a turn before the app closed");
        end_tagged(&[tag.to_string()]);
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

/// The PATH of the person's login shell. An app opened from Finder starts with
/// only the system folders, where `claude`, `codex`, and `uv` are not.
fn login_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let current = std::env::var("PATH").unwrap_or_default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
        let marker = "__M3D_PATH__";
        let from_shell = std::process::Command::new(shell)
            .args(["-ilc", &format!("printf '{marker}%s' \"$PATH\"")])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|out| String::from_utf8_lossy(&out.stdout).rsplit_once(marker).map(|(_, path)| path.trim().to_owned()))
            .filter(|path| !path.is_empty());
        match from_shell {
            Some(path) if current.is_empty() => path,
            Some(path) => format!("{path}:{current}"),
            None => current,
        }
    })
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
    let meta = read_meta(&dir)?;
    let mut content: Vec<Value> = images.iter().map(|rel| image_block(&dir, rel)).collect::<Result<_, _>>()?;
    let mut prompt = text.clone();
    if !images.is_empty() {
        prompt.push_str(&format!("\n\n(Pictures attached, saved in this folder as: {})", images.join(", ")));
    }
    content.push(json!({ "type": "text", "text": prompt }));
    let message = json!({ "type": "user", "message": { "role": "user", "content": content } });

    let token = CancellationToken::new();
    let tag = uuid::Uuid::new_v4().to_string();
    {
        let mut running = turns.0.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&project) {
            return Err("The agent is still working on the last message.".to_owned());
        }
        running.insert(project.clone(), Turn { token: token.clone(), tag: tag.clone() });
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
        .current_dir(&dir)
        .env("PATH", login_path())
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
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
        let outcome = run(&app, &project, &mut transcript, &started, command, message, token, &tag).await;
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
    });
    Ok(())
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
) -> Result<(), String> {
    // Written before the agent starts and removed when this run ends, so a crash leaves it behind.
    let tag_file = tag_path(&transcript.dir);
    // Written whole or not at all, so a crash never leaves a partial tag.
    let staged = tag_file.with_extension("turn.new");
    std::fs::write(&staged, tag).and_then(|()| std::fs::rename(&staged, &tag_file)).map_err(|e| format!("{}: {e}", tag_file.display()))?;
    let _tag_file = RemoveOnDrop(tag_file);
    let mut child = command.spawn().map_err(|e| format!("could not start the claude CLI: {e}. Install Claude Code and sign in."))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let line = format!("{message}\n");
    // A Stop or a quit that came while the agent was starting ends it here.
    tokio::select! {
        () = token.cancelled() => {
            stop(&mut child, tag).await;
            return Err("Stopped.".to_owned());
        }
        written = stdin.write_all(line.as_bytes()) => written.map_err(|e| format!("writing to claude: {e}"))?,
    }
    drop(stdin);

    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let mut result_error: Option<String> = None;
    loop {
        let line = tokio::select! {
            () = token.cancelled() => {
                stop(&mut child, tag).await;
                return Err("Stopped.".to_owned());
            }
            line = lines.next_line() => line.map_err(|e| format!("reading claude output: {e}"))?,
        };
        let Some(line) = line else { break };
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
    let status = child.wait().await.map_err(|e| format!("waiting for claude: {e}"))?;
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

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Ends the agent and every tool it started: a polite signal first so Claude
/// Code can stop its tools, then a kill for whatever still carries the turn's tag.
async fn stop(child: &mut tokio::process::Child, tag: &str) {
    let tags = vec![tag.to_owned()];
    let _ = tauri::async_runtime::spawn_blocking(move || end_tagged(&tags)).await;
    let _ = child.kill().await;
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

    #[cfg(unix)]
    #[test]
    fn a_tagged_tool_in_its_own_group_is_ended_and_an_untagged_one_is_not() {
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
        end_tagged(&[tag.clone()]);
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
