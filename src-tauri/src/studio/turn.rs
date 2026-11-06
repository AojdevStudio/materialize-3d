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

/// The running turn of each project, so a second send waits and Stop can end it.
#[derive(Default)]
pub struct Turns(Mutex<HashMap<String, CancellationToken>>);

fn transcript_path(dir: &Path) -> PathBuf {
    dir.join(META_DIR).join("transcript.jsonl")
}

fn append(dir: &Path, event: &Value) -> Result<(), String> {
    let path = transcript_path(dir);
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    writeln!(file, "{event}").map_err(|e| format!("{}: {e}", path.display()))
}

/// Everything said in the project so far, in order.
#[tauri::command]
pub fn studio_transcript(project: String) -> Result<Vec<Value>, String> {
    let path = transcript_path(&project_dir(&project)?);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
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
    {
        let mut running = turns.0.lock().map_err(|e| e.to_string())?;
        if running.contains_key(&project) {
            return Err("The agent is still working on the last message.".to_owned());
        }
        running.insert(project.clone(), token.clone());
    }
    let user = json!({ "type": "m3d_user", "text": text, "images": images });
    append(&dir, &user)?;
    let _ = app.emit(EVENT, json!({ "project": project, "event": user }));

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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    tauri::async_runtime::spawn(async move {
        let before: HashMap<String, u64> = files::list(&dir).unwrap_or_default().into_iter().map(|f| (f.rel.clone(), f.modified_ms)).collect();
        let outcome = run(&app, &project, &dir, &started, command, message, token).await;
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
            if let Err(e) = append(&dir, &event) {
                log::error!("studio: transcript write failed: {e}");
            }
            let _ = app.emit(EVENT, json!({ "project": project, "event": event }));
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
    dir: &Path,
    started: &Path,
    mut command: tokio::process::Command,
    message: Value,
    token: CancellationToken,
) -> Result<(), String> {
    let mut child = command.spawn().map_err(|e| format!("could not start the claude CLI: {e}. Install Claude Code and sign in."))?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(format!("{message}\n").as_bytes()).await.map_err(|e| format!("writing to claude: {e}"))?;
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
                let _ = child.kill().await;
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
            append(dir, &event)?;
            let _ = app.emit(EVENT, json!({ "project": project, "event": event }));
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

/// Stops the project's running turn.
#[tauri::command]
pub fn studio_cancel(turns: State<'_, Turns>, project: String) -> Result<(), String> {
    if let Some(token) = turns.0.lock().map_err(|e| e.to_string())?.get(&project) {
        token.cancel();
    }
    Ok(())
}
