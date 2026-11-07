//! The chat studio: one project folder per chat, a Claude Code agent that works
//! in it, and the files it writes.
//!
//! The agent is the local `claude` CLI, so it runs on the person's own login and
//! carries their skills, tools, and settings. Each turn is one `claude -p` run
//! in the project folder; later turns resume the same session.

pub mod files;
mod lean;
pub mod turn;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use files::register_protocol;
pub use turn::Turns;

/// Hidden folder in each project for the app's own records.
const META_DIR: &str = ".m3d";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMeta {
    title: String,
    created_ms: i64,
    /// The Claude Code session every turn after the first resumes.
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    title: String,
    created_ms: i64,
    path: PathBuf,
}

/// Whether the main window, or a preview frame in it, may go to `url`. The
/// app's own pages and project files may load. The internet may not, so a
/// preview page cannot carry project data out by navigating its frame there.
pub fn may_navigate(url: &url::Url) -> bool {
    let local = match url.scheme() {
        "tauri" | "m3dfile" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(url.host_str(), Some("localhost" | "tauri.localhost" | "127.0.0.1")),
        _ => false,
    };
    if !local {
        log::warn!("studio: blocked navigation to {}://{}", url.scheme(), url.host_str().unwrap_or(""));
    }
    local
}

/// Where projects live: `~/Documents/Materialize 3D`. A verification run keeps
/// its projects in its own data folder.
fn projects_root() -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(dir) = std::env::var_os("M3D_E2E_DATA_DIR") {
        return Ok(PathBuf::from(dir).join("projects"));
    }
    let docs = dirs::document_dir().or_else(dirs::home_dir).ok_or("no Documents or home folder")?;
    Ok(docs.join("Materialize 3D"))
}

/// A project id is one plain folder name, never a path. Ids are `<date>-<slug>`,
/// which is also a valid host name that starts with a digit: the preview serves
/// each project as its own host.
fn project_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\']) {
        return Err(format!("bad project id {id:?}"));
    }
    Ok(projects_root()?.join(id))
}

fn read_meta(dir: &Path) -> Result<ProjectMeta, String> {
    let path = dir.join(META_DIR).join("project.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parsing {}: {e}", path.display()))
}

fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() { "project".to_owned() } else { out }
}

/// Every project, newest first. A folder without the app's record is not a project.
#[tauri::command]
pub fn studio_projects() -> Result<Vec<Project>, String> {
    let root = projects_root()?;
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("reading {}: {e}", root.display())),
    };
    let mut projects: Vec<Project> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let meta = read_meta(&path).ok()?;
            Some(Project { id: entry.file_name().to_string_lossy().into_owned(), title: meta.title, created_ms: meta.created_ms, path })
        })
        .collect();
    projects.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    Ok(projects)
}

/// Makes a new project folder named after the first request.
#[tauri::command]
pub fn studio_create_project(title: String) -> Result<Project, String> {
    let root = projects_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("creating {}: {e}", root.display()))?;
    let now = chrono::Local::now();
    let base = format!("{}-{}", now.format("%Y-%m-%d"), slug(&title));
    let (id, path) = (1..)
        .map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") })
        .map(|id| (id.clone(), root.join(id)))
        .find(|(_, path)| !path.exists())
        .expect("an unused folder name");
    std::fs::create_dir_all(path.join(META_DIR)).map_err(|e| format!("creating {}: {e}", path.display()))?;
    let title: String = title.lines().next().unwrap_or_default().chars().take(80).collect();
    let meta = ProjectMeta { title: title.clone(), created_ms: now.timestamp_millis(), session_id: uuid::Uuid::new_v4().to_string() };
    let text = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(path.join(META_DIR).join("project.json"), text).map_err(|e| format!("writing project record: {e}"))?;
    Ok(Project { id, title, created_ms: meta.created_ms, path })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_words_and_drops_the_rest() {
        assert_eq!(slug("A wall mount for my UGREEN dock!"), "a-wall-mount-for-my-ugreen-dock");
        assert_eq!(slug("   "), "project");
    }

    #[test]
    fn the_window_stays_on_the_app_and_project_files() {
        let may = |url: &str| may_navigate(&url.parse().expect("url"));
        assert!(may("tauri://localhost/index.html"));
        assert!(may("http://localhost:1420/"));
        assert!(may("m3dfile://2026-11-06-clip/guide.html"));
        assert!(!may("https://example.com/?leak=1"));
        assert!(!may("http://192.168.1.5/"));
    }

    #[test]
    fn project_ids_are_plain_folder_names() {
        assert!(project_dir("../etc").is_err());
        assert!(project_dir(".m3d").is_err());
        assert!(project_dir("").is_err());
    }
}
