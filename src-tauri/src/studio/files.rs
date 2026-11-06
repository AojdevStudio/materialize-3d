//! The files in a project folder: the list, the pictures Ossie adds, the
//! `m3dfile://` protocol the preview panel loads them through, and the two
//! hand-offs to the operating system.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::http::{header, Response, StatusCode};

use super::{project_dir, META_DIR};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    /// Path inside the project, `/`-separated.
    pub(super) rel: String,
    size: u64,
    pub(super) modified_ms: u64,
}

/// Folders a person never wants to see in the file list.
fn skipped(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "__pycache__" | "node_modules" | "venv")
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<ProjectFile>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if skipped(&name.to_string_lossy()) {
            continue;
        }
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            walk(root, &path, out)?;
        } else if kind.is_file() {
            let meta = entry.metadata()?;
            let modified_ms = meta.modified()?.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
            let rel = path.strip_prefix(root).expect("walked under root").components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            out.push(ProjectFile { rel, size: meta.len(), modified_ms });
        }
    }
    Ok(())
}

pub(super) fn list(dir: &Path) -> Result<Vec<ProjectFile>, String> {
    let mut out = Vec::new();
    walk(dir, dir, &mut out).map_err(|e| format!("listing {}: {e}", dir.display()))?;
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// Every file in the project, newest first.
#[tauri::command]
pub fn studio_files(project: String) -> Result<Vec<ProjectFile>, String> {
    list(&project_dir(&project)?)
}

/// Resolves a path inside a project. Refuses anything that would leave the folder,
/// including through a symlink, and the app's own records.
fn resolve(project: &str, rel: &str) -> Result<PathBuf, String> {
    let dir = project_dir(project)?;
    let rel_path = Path::new(rel);
    if !rel_path.components().all(|c| matches!(c, Component::Normal(_))) || rel_path.starts_with(META_DIR) {
        return Err(format!("bad file path {rel:?}"));
    }
    let full = dir.join(rel_path).canonicalize().map_err(|e| format!("{rel}: {e}"))?;
    let root = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
    if !full.starts_with(&root) || full.starts_with(root.join(META_DIR)) {
        return Err(format!("{rel} is outside the project"));
    }
    Ok(full)
}

/// A file name for `refs/` that keeps the original name and never overwrites.
fn free_ref_name(dir: &Path, name: &str) -> Result<(PathBuf, String), String> {
    std::fs::create_dir_all(dir.join("refs")).map_err(|e| format!("creating {}: {e}", dir.join("refs").display()))?;
    // `refs` could be a symlink the agent made. Pictures land inside the project or nowhere.
    let refs = dir.join("refs").canonicalize().map_err(|e| format!("refs: {e}"))?;
    if !refs.starts_with(dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?) {
        return Err("refs/ points outside the project".to_owned());
    }
    let clean: String = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '-' }).collect())
        .filter(|n: &String| !n.trim_matches('.').is_empty())
        .unwrap_or_else(|| "picture.png".to_owned());
    let (stem, ext) = match clean.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_owned(), format!(".{ext}")),
        None => (clean.clone(), String::new()),
    };
    (1..)
        .map(|n| if n == 1 { clean.clone() } else { format!("{stem}-{n}{ext}") })
        .map(|file| (refs.join(&file), format!("refs/{file}")))
        .find(|(path, _)| !path.exists())
        .ok_or_else(|| "no free file name".to_owned())
}

/// Copies a dropped file into the project's `refs/` folder and returns its path there.
#[tauri::command]
pub fn studio_import_file(project: String, source: String) -> Result<String, String> {
    let dir = project_dir(&project)?;
    let (target, rel) = free_ref_name(&dir, &source)?;
    std::fs::copy(&source, &target).map_err(|e| format!("copying {source}: {e}"))?;
    Ok(rel)
}

/// Saves pasted bytes into `refs/`. The body is the raw file; the project and
/// name ride in headers so a photo never goes through JSON.
#[tauri::command]
pub fn studio_save_bytes(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let header = |name: &str| {
        request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned).ok_or_else(|| format!("missing {name} header"))
    };
    let project = header("m3d-project")?;
    // The name is percent-encoded, because a header holds only ASCII.
    let name = percent_encoding::percent_decode_str(&header("m3d-name")?).decode_utf8_lossy().into_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".to_owned());
    };
    let (target, rel) = free_ref_name(&project_dir(&project)?, &name)?;
    std::fs::write(&target, bytes).map_err(|e| format!("writing {}: {e}", target.display()))?;
    Ok(rel)
}

fn spawn_detached(program: &str, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    std::process::Command::new(program).args(args).spawn().map(drop).map_err(|e| format!("{program}: {e}"))
}

/// Shows the file in Finder (or the Linux file manager, at its folder).
#[tauri::command]
pub fn studio_reveal(project: String, rel: String) -> Result<(), String> {
    let path = resolve(&project, &rel)?;
    if cfg!(target_os = "macos") {
        spawn_detached("open", &["-R".as_ref(), path.as_os_str()])
    } else {
        spawn_detached("xdg-open", &[path.parent().expect("file has a folder").as_os_str()])
    }
}

/// Opens a 3MF (or STL) in Bambu Studio.
#[tauri::command]
pub fn studio_open_in_bambu(project: String, rel: String) -> Result<(), String> {
    let path = resolve(&project, &rel)?;
    if cfg!(target_os = "macos") {
        let status = std::process::Command::new("open")
            .args(["-a".as_ref(), "BambuStudio".as_ref(), path.as_os_str()])
            .status()
            .map_err(|e| format!("open: {e}"))?;
        if !status.success() {
            return Err("Bambu Studio is not installed in Applications".to_owned());
        }
        Ok(())
    } else {
        spawn_detached("xdg-open", &[path.as_os_str()])
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("glb") => "model/gltf-binary",
        Some("gltf") => "model/gltf+json",
        Some("txt" | "md" | "py" | "scad") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The app's own pages: the bundled UI on macOS and Linux, on Windows, and the dev server.
const APP_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"];

/// The project and the path inside it. Each project is its own host,
/// `m3dfile://<project>/<path>`, so each is its own origin: a preview page
/// reads its own project's files and no other's. Windows has no custom hosts,
/// so there the project is the first path segment of `http://m3dfile.localhost/`.
fn request_parts(uri: &tauri::http::Uri) -> Vec<String> {
    let segments = uri.path().trim_start_matches('/').split('/').map(|part| percent_encoding::percent_decode_str(part).decode_utf8_lossy().into_owned());
    match uri.host() {
        Some(host) if host != "m3dfile.localhost" => std::iter::once(host.to_owned()).chain(segments).collect(),
        _ => segments.collect(),
    }
}

/// Serves project files. The preview frame loads pages from here so their
/// relative links work, and the 3D viewer fetches models. Only the app's own
/// window may read across projects.
fn serve(request: &tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    let decoded = request_parts(request.uri());
    let allow = request.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).filter(|o| APP_ORIGINS.contains(o)).map(str::to_owned);
    let respond = |status: StatusCode, kind: &str, body: Vec<u8>| {
        let mut response = Response::builder().status(status).header(header::CONTENT_TYPE, kind).header(header::CACHE_CONTROL, "no-store");
        if let Some(origin) = &allow {
            response = response.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.as_str());
        }
        response.body(body).expect("valid response")
    };
    let Some((project, rest)) = decoded.split_first() else {
        return respond(StatusCode::NOT_FOUND, "text/plain", b"no project".to_vec());
    };
    let found = resolve(project, &rest.join("/")).and_then(|path| std::fs::read(&path).map(|bytes| (path, bytes)).map_err(|e| e.to_string()));
    match found {
        Ok((path, bytes)) => respond(StatusCode::OK, content_type(&path), bytes),
        Err(e) => respond(StatusCode::NOT_FOUND, "text/plain", e.into_bytes()),
    }
}

pub fn register_protocol<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("m3dfile", |_ctx, request, responder| {
        std::thread::spawn(move || responder.respond(serve(&request)));
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_project_is_its_own_host() {
        let parts = |uri: &str| request_parts(&uri.parse().expect("uri"));
        assert_eq!(parts("m3dfile://2026-11-06-clip/print/a%20b.3mf"), ["2026-11-06-clip", "print", "a b.3mf"]);
        assert_eq!(parts("http://m3dfile.localhost/2026-11-06-clip/guide.html"), ["2026-11-06-clip", "guide.html"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_refs_folder_cannot_take_a_picture_out() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("outside");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("refs")).expect("symlink");
        assert!(free_ref_name(dir.path(), "photo.jpg").is_err());
    }

    #[test]
    fn ref_names_never_overwrite_and_never_escape() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (first, rel) = free_ref_name(dir.path(), "/Users/x/Desktop/arm photo.JPG").expect("name");
        assert_eq!(rel, "refs/arm-photo.JPG");
        std::fs::write(&first, b"x").expect("write");
        let (_, second) = free_ref_name(dir.path(), "arm photo.JPG").expect("name");
        assert_eq!(second, "refs/arm-photo-2.JPG");
        let (_, odd) = free_ref_name(dir.path(), "..").expect("name");
        assert_eq!(odd, "refs/picture.png");
    }
}
