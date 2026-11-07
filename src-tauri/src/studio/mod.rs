//! The chat studio's native edges: the project folders the agent works in, the
//! files it writes, the preview's navigation guard, and the slice step. The
//! chats themselves live in the sidecar's store (`crate::sidecar`).

pub mod files;
pub mod quit;
pub mod slice;

use std::path::PathBuf;

pub use files::register_protocol;

/// Hidden folder in each project for the app's own records: converted photos, and a chat from before the store.
/// The preview and the file list never show it.
const META_DIR: &str = ".m3d";

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
pub(crate) fn projects_root() -> Result<PathBuf, String> {
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
pub(crate) fn project_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\']) {
        return Err(format!("bad project id {id:?}"));
    }
    Ok(projects_root()?.join(id))
}

#[cfg(test)]
mod tests {
    use super::*;

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
