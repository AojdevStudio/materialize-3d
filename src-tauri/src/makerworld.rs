use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Webview, WebviewUrl,
    webview::{DownloadEvent, PageLoadEvent, WebviewBuilder},
};
use url::Url;

use crate::state::{
    AppState, MAKERWORLD_HOME_URL, MakerWorldFile, MakerWorldModel, MakerWorldPageKind,
    ModelImportStatus, ModelInfo,
};

pub const MAKERWORLD_WEBVIEW_LABEL: &str = "makerworld";
const MAKERWORLD_CONTENT_SCRIPT: &str = include_str!("makerworld_content_script.js");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerWorldWebviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerWorldPageReport {
    pub current_url: String,
    pub page_kind: MakerWorldPageKind,
    pub detected_model: Option<MakerWorldModel>,
    #[serde(default)]
    pub last_extraction_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MakerWorldImportAttempt {
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub import_status: ModelImportStatus,
    pub imported_files: Vec<String>,
}

#[derive(Debug, Clone)]
struct PendingDownload {
    destination: PathBuf,
}

#[derive(Clone, Default)]
pub struct MakerWorldService {
    pending_downloads: Arc<Mutex<HashMap<String, PendingDownload>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredImportMetadata {
    imported_at: String,
    source_url: String,
    model: Option<MakerWorldModel>,
    files: Vec<String>,
}

pub fn sync_webview(
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &MakerWorldService,
    bounds: MakerWorldWebviewBounds,
) -> Result<(), String> {
    ensure_webview(app, state, service)?;

    let webview = app
        .get_webview(MAKERWORLD_WEBVIEW_LABEL)
        .ok_or_else(|| "makerworld webview unavailable after creation".to_string())?;

    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("failed to position makerworld webview: {error}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
        .map_err(|error| format!("failed to size makerworld webview: {error}"))?;

    if bounds.visible {
        webview
            .show()
            .map_err(|error| format!("failed to show makerworld webview: {error}"))?;
        webview
            .set_focus()
            .map_err(|error| format!("failed to focus makerworld webview: {error}"))?;
    } else {
        webview
            .hide()
            .map_err(|error| format!("failed to hide makerworld webview: {error}"))?;
    }

    Ok(())
}

pub fn navigate(
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &MakerWorldService,
    raw_target: &str,
) -> Result<(), String> {
    let target = normalize_navigation_target(raw_target)?;
    ensure_webview(app, state, service)?;

    set_browser_url(app, state, &target)?;

    if let Some(webview) = app.get_webview(MAKERWORLD_WEBVIEW_LABEL) {
        webview
            .navigate(target.parse::<Url>().map_err(|error| format!("invalid makerworld url: {error}"))?)
            .map_err(|error| format!("failed to navigate makerworld webview: {error}"))?;
        webview
            .show()
            .map_err(|error| format!("failed to show makerworld webview: {error}"))?;
    }

    Ok(())
}

pub fn search(
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &MakerWorldService,
    query: &str,
) -> Result<(), String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("search query cannot be empty".into());
    }

    let encoded = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect::<String>();
    let url = format!("https://makerworld.com/en/search/models?keyword={encoded}");
    navigate(app, state, service, &url)
}

pub fn back(app: &AppHandle, state: &Arc<AppState>, service: &MakerWorldService) -> Result<(), String> {
    ensure_webview(app, state, service)?;
    let webview = app
        .get_webview(MAKERWORLD_WEBVIEW_LABEL)
        .ok_or_else(|| "makerworld webview not available".to_string())?;
    webview
        .eval("history.back();")
        .map_err(|error| format!("failed to navigate back in makerworld: {error}"))
}

pub fn forward(
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &MakerWorldService,
) -> Result<(), String> {
    ensure_webview(app, state, service)?;
    let webview = app
        .get_webview(MAKERWORLD_WEBVIEW_LABEL)
        .ok_or_else(|| "makerworld webview not available".to_string())?;
    webview
        .eval("history.forward();")
        .map_err(|error| format!("failed to navigate forward in makerworld: {error}"))
}

pub fn reload(
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &MakerWorldService,
) -> Result<(), String> {
    ensure_webview(app, state, service)?;
    let webview = app
        .get_webview(MAKERWORLD_WEBVIEW_LABEL)
        .ok_or_else(|| "makerworld webview not available".to_string())?;
    webview
        .reload()
        .map_err(|error| format!("failed to reload makerworld webview: {error}"))
}

pub fn import_current_model(
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &MakerWorldService,
) -> Result<(), String> {
    ensure_webview(app, state, service)?;

    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?;
        if workspace.makerworld.detected_model.is_none() {
            return Err("no MakerWorld model detected on the current page".into());
        }
        workspace.makerworld.import_status = ModelImportStatus::Downloading;
        workspace.makerworld.last_extraction_error = None;
    }
    state.emit_state_change(app, "workspace:changed")?;

    let webview = app
        .get_webview(MAKERWORLD_WEBVIEW_LABEL)
        .ok_or_else(|| "makerworld webview not available".to_string())?;

    webview
        .eval(
            "window.__MATERIALIZE_IMPORT_CURRENT_MODEL__ && window.__MATERIALIZE_IMPORT_CURRENT_MODEL__();",
        )
        .map_err(|error| format!("failed to trigger MakerWorld import: {error}"))
}

pub fn report_page<R: Runtime>(
    webview: Webview<R>,
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    payload: MakerWorldPageReport,
) -> Result<(), String> {
    validate_remote_report(&webview)?;

    let sanitized_url = normalize_navigation_target(&payload.current_url)?;
    let page_kind = match payload.page_kind {
        MakerWorldPageKind::Other => classify_page_kind(&sanitized_url),
        reported => reported,
    };
    let detected_model = payload.detected_model.map(sanitize_model);
    let extraction_error = payload
        .last_extraction_error
        .and_then(|value| sanitize_optional_string(Some(value), 280));

    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?;
        // Don't force active_view to Browser — reports come from the content script
        // which runs in the background regardless of which tab the user has active.
        workspace.makerworld.current_url = sanitized_url;
        workspace.makerworld.page_kind = page_kind.clone();
        workspace.makerworld.detected_model = detected_model;
        workspace.makerworld.last_extraction_error = extraction_error;

        if matches!(workspace.makerworld.import_status, ModelImportStatus::Downloading | ModelImportStatus::Imported) {
            // Preserve in-flight / finished import state.
        } else if workspace.makerworld.detected_model.is_some() && page_kind == MakerWorldPageKind::Model {
            workspace.makerworld.import_status = ModelImportStatus::Ready;
        } else if workspace.makerworld.last_extraction_error.is_some() {
            workspace.makerworld.import_status = ModelImportStatus::Error;
        } else {
            workspace.makerworld.import_status = ModelImportStatus::Idle;
        }
    }

    state.emit_state_change(app, "workspace:changed")
}

pub fn report_import_attempt<R: Runtime>(
    webview: Webview<R>,
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    payload: MakerWorldImportAttempt,
) -> Result<(), String> {
    validate_remote_report(&webview)?;

    if payload.success {
        return Ok(());
    }

    let message = sanitize_optional_string(payload.error, 240)
        .unwrap_or_else(|| "MakerWorld import button was not found on the page".into());

    let mut workspace = state
        .workspace
        .lock()
        .map_err(|error| format!("failed to lock workspace state: {error}"))?;
    workspace.makerworld.import_status = ModelImportStatus::Error;
    workspace.makerworld.last_extraction_error = Some(message);
    drop(workspace);

    state.emit_state_change(app, "workspace:changed")
}

fn ensure_webview(
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &MakerWorldService,
) -> Result<(), String> {
    if app.get_webview(MAKERWORLD_WEBVIEW_LABEL).is_some() {
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let current_url = {
        let workspace = state
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?;
        normalize_navigation_target(&workspace.makerworld.current_url)?
    };

    let app_for_load = app.clone();
    let state_for_load = Arc::clone(state);
    let app_for_download = app.clone();
    let state_for_download = Arc::clone(state);
    let service_for_download = service.clone();

    let builder = WebviewBuilder::new(
        MAKERWORLD_WEBVIEW_LABEL,
        WebviewUrl::External(current_url.parse::<Url>().map_err(|error| format!("invalid makerworld url: {error}"))?),
    )
    .initialization_script(MAKERWORLD_CONTENT_SCRIPT)
    .on_page_load(move |webview, payload| {
        if payload.event() != PageLoadEvent::Finished {
            return;
        }

        log::info!("makerworld page finished loading: {}", payload.url());
        if let Err(error) = set_current_page_from_url(&app_for_load, &state_for_load, payload.url().as_str()) {
            log::warn!("failed to sync makerworld url from page load: {error}");
        }
        if let Err(error) = webview.eval(
            "window.__MATERIALIZE_SCAN__ && window.__MATERIALIZE_SCAN__('page-load');",
        ) {
            log::warn!("failed to trigger makerworld content scan: {error}");
        }
    })
    .on_download(move |webview, event| {
        handle_download(
            webview,
            event,
            &app_for_download,
            &state_for_download,
            &service_for_download,
        )
    });

    window
        .add_child(
            builder,
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(100.0, 100.0),
        )
        .map_err(|error| format!("failed to create makerworld child webview: {error}"))?;

    if let Some(webview) = app.get_webview(MAKERWORLD_WEBVIEW_LABEL) {
        webview
            .hide()
            .map_err(|error| format!("failed to hide makerworld webview after creation: {error}"))?;
    }

    Ok(())
}

fn handle_download<R: Runtime>(
    _webview: Webview<R>,
    event: DownloadEvent<'_>,
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    service: &MakerWorldService,
) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            match prepare_download_destination(app, state, &url) {
                Ok(path) => {
                    if let Some(parent) = path.parent() {
                        if let Err(error) = fs::create_dir_all(parent) {
                            log::warn!("failed to create MakerWorld import directory: {error}");
                            return false;
                        }
                    }
                    *destination = path.clone();
                    if let Ok(mut pending) = service.pending_downloads.lock() {
                        pending.insert(url.to_string(), PendingDownload { destination: path });
                    }
                    log::info!("makerworld download requested: {url}");
                }
                Err(error) => {
                    log::warn!("failed to prepare makerworld download destination: {error}");
                    if let Err(update_error) = set_import_error(app, state, error) {
                        log::warn!("failed to persist makerworld import error: {update_error}");
                    }
                    return false;
                }
            }
        }
        DownloadEvent::Finished { url, path, success } => {
            let final_path = if path.is_some() {
                path
            } else if let Ok(mut pending) = service.pending_downloads.lock() {
                pending.remove(&url.to_string()).map(|pending| pending.destination)
            } else {
                None
            };

            if success {
                if let Some(path) = final_path {
                    if let Err(error) = finalize_import(app, state, &path) {
                        log::warn!("failed to finalize MakerWorld import: {error}");
                    }
                } else if let Err(error) = set_import_error(
                    app,
                    state,
                    "MakerWorld download finished without a destination path".into(),
                ) {
                    log::warn!("failed to record missing makerworld download path: {error}");
                }
            } else if let Err(error) = set_import_error(app, state, format!("MakerWorld download failed for {url}")) {
                log::warn!("failed to record MakerWorld download failure: {error}");
            }
        }
        _ => {}
    }

    true
}

fn set_current_page_from_url(app: &AppHandle, state: &Arc<AppState>, url: &str) -> Result<(), String> {
    let normalized = normalize_navigation_target(url)?;
    let page_kind = classify_page_kind(&normalized);

    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?;
        // Don't force active_view to Browser — this is called from on_page_load which fires
        // in the background even when the user is on a different tab. Only update MakerWorld state.
        workspace.makerworld.current_url = normalized;
        workspace.makerworld.page_kind = page_kind.clone();
        if page_kind != MakerWorldPageKind::Model {
            workspace.makerworld.detected_model = None;
            if !matches!(workspace.makerworld.import_status, ModelImportStatus::Downloading | ModelImportStatus::Imported) {
                workspace.makerworld.import_status = ModelImportStatus::Idle;
            }
        }
    }

    state.emit_state_change(app, "workspace:changed")
}

fn set_browser_url(app: &AppHandle, state: &Arc<AppState>, url: &str) -> Result<(), String> {
    let page_kind = classify_page_kind(url);
    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?;
        // Don't force active_view to Browser — this is called from navigate/search commands
        // which should update MakerWorld state without hijacking the active view.
        // The user switches views explicitly via set_active_view.
        workspace.makerworld.current_url = url.into();
        workspace.makerworld.page_kind = page_kind.clone();
        if page_kind != MakerWorldPageKind::Model {
            workspace.makerworld.detected_model = None;
            if !matches!(workspace.makerworld.import_status, ModelImportStatus::Downloading | ModelImportStatus::Imported) {
                workspace.makerworld.import_status = ModelImportStatus::Idle;
            }
        }
    }

    state.emit_state_change(app, "workspace:changed")
}

fn finalize_import<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    downloaded_path: &Path,
) -> Result<(), String> {
    let downloaded_path = downloaded_path
        .canonicalize()
        .unwrap_or_else(|_| downloaded_path.to_path_buf());

    let (model_name, model_id, source_url, imported_files, detected_model) = {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?;

        let next_path = downloaded_path.to_string_lossy().to_string();
        if !workspace.makerworld.imported_files.iter().any(|path| path == &next_path) {
            workspace.makerworld.imported_files.push(next_path.clone());
        }
        workspace.makerworld.import_status = ModelImportStatus::Imported;
        workspace.makerworld.last_extraction_error = None;

        let model = workspace.makerworld.detected_model.clone();
        let model_name = model
            .as_ref()
            .map(|model| model.title.clone())
            .unwrap_or_else(|| file_stem_or_name(&downloaded_path));
        let source_url = model
            .as_ref()
            .map(|model| model.source_url.clone())
            .unwrap_or_else(|| workspace.makerworld.current_url.clone());
        let model_id = model.as_ref().and_then(|model| model.id.clone());
        let file_size = fs::metadata(&downloaded_path).ok().map(|meta| meta.len());

        workspace.active_model = Some(ModelInfo {
            id: model_id.clone(),
            name: model_name.clone(),
            path: Some(next_path),
            source: Some(source_url.clone()),
            size_bytes: file_size,
        });

        (
            model_name,
            model_id,
            source_url,
            workspace.makerworld.imported_files.clone(),
            model,
        )
    };

    persist_import_metadata(app, &model_name, model_id.as_deref(), &source_url, detected_model, imported_files)?;
    state.emit_state_change(app, "workspace:changed")
}

fn persist_import_metadata<R: Runtime>(
    app: &AppHandle<R>,
    model_name: &str,
    model_id: Option<&str>,
    source_url: &str,
    detected_model: Option<MakerWorldModel>,
    imported_files: Vec<String>,
) -> Result<(), String> {
    let library_dir = library_root(app)?;
    fs::create_dir_all(&library_dir)
        .map_err(|error| format!("failed to create makerworld library root: {error}"))?;

    let folder_name = match model_id {
        Some(id) if !id.is_empty() => format!("{}-{}", slugify(model_name), id),
        _ => slugify(model_name),
    };
    let model_dir = library_dir.join(folder_name);
    fs::create_dir_all(&model_dir)
        .map_err(|error| format!("failed to create makerworld model directory: {error}"))?;

    let metadata = StoredImportMetadata {
        imported_at: Utc::now().to_rfc3339(),
        source_url: source_url.into(),
        model: detected_model,
        files: imported_files,
    };

    let metadata_path = model_dir.join("metadata.json");
    fs::write(
        metadata_path,
        serde_json::to_vec_pretty(&metadata)
            .map_err(|error| format!("failed to serialize makerworld metadata: {error}"))?,
    )
    .map_err(|error| format!("failed to write makerworld metadata: {error}"))
}

fn prepare_download_destination<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    url: &Url,
) -> Result<PathBuf, String> {
    let library_dir = library_root(app)?;
    fs::create_dir_all(&library_dir)
        .map_err(|error| format!("failed to create makerworld library root: {error}"))?;

    let workspace = state
        .workspace
        .lock()
        .map_err(|error| format!("failed to lock workspace state: {error}"))?;
    let model = workspace.makerworld.detected_model.clone();
    let folder_name = model
        .as_ref()
        .map(|model| match model.id.as_deref() {
            Some(id) if !id.is_empty() => format!("{}-{}", slugify(&model.title), id),
            _ => slugify(&model.title),
        })
        .unwrap_or_else(|| slugify("makerworld-import"));
    let filename = infer_download_filename(url, model.as_ref());

    Ok(library_dir.join(folder_name).join(filename))
}

fn infer_download_filename(url: &Url, model: Option<&MakerWorldModel>) -> String {
    if let Some(segment) = url
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|segment| !segment.is_empty())
    {
        let cleaned = segment.split('?').next().unwrap_or(segment);
        if cleaned.contains('.') {
            return cleaned.to_string();
        }
    }

    let base = model
        .map(|model| slugify(&model.title))
        .unwrap_or_else(|| "makerworld-download".into());
    if let Some(file) = model.and_then(|model| model.files.first()) {
        if let Some(ext) = file
            .file_type
            .as_deref()
            .map(|value| value.trim_matches('.').to_ascii_lowercase())
            .filter(|value| !value.is_empty())
        {
            return format!("{base}.{ext}");
        }
    }
    format!("{base}.zip")
}

fn library_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or_else(|| "failed to resolve local data directory".to_string())?;
    let bundle_id = app.config().identifier.clone();
    Ok(base.join(bundle_id).join("library").join("makerworld"))
}

fn file_stem_or_name(path: &Path) -> String {
    path.file_stem()
        .or_else(|| path.file_name())
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| "Imported MakerWorld model".into())
}

fn set_import_error<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    error: String,
) -> Result<(), String> {
    let mut workspace = state
        .workspace
        .lock()
        .map_err(|lock_error| format!("failed to lock workspace state: {lock_error}"))?;
    workspace.makerworld.import_status = ModelImportStatus::Error;
    workspace.makerworld.last_extraction_error = Some(error);
    drop(workspace);
    state.emit_state_change(app, "workspace:changed")
}

fn validate_remote_report<R: Runtime>(webview: &Webview<R>) -> Result<(), String> {
    if webview.label() != MAKERWORLD_WEBVIEW_LABEL {
        return Err("MakerWorld reports are only accepted from the makerworld child webview".into());
    }

    let url = webview
        .url()
        .map_err(|error| format!("failed to resolve reporting webview url: {error}"))?;
    let host = url.host_str().unwrap_or_default();
    if !host.ends_with("makerworld.com") {
        return Err(format!("unexpected remote host for MakerWorld report: {host}"));
    }

    Ok(())
}

fn normalize_navigation_target(target: &str) -> Result<String, String> {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return Ok(MAKERWORLD_HOME_URL.into());
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url = Url::parse(trimmed).map_err(|error| format!("invalid makerworld url: {error}"))?;
        let host = url.host_str().unwrap_or_default();
        if !host.ends_with("makerworld.com") {
            return Err("only makerworld.com URLs are allowed in the embedded browser".into());
        }
        return Ok(url.to_string());
    }

    if trimmed.starts_with("makerworld.com") || trimmed.starts_with("www.makerworld.com") {
        return normalize_navigation_target(&format!("https://{trimmed}"));
    }

    Ok(trimmed.into())
}

pub fn classify_page_kind(url: &str) -> MakerWorldPageKind {
    if url.contains("/search/") {
        MakerWorldPageKind::Search
    } else if url.contains("/models/") {
        MakerWorldPageKind::Model
    } else if url == MAKERWORLD_HOME_URL || url == format!("{MAKERWORLD_HOME_URL}/") {
        MakerWorldPageKind::Home
    } else {
        MakerWorldPageKind::Other
    }
}

fn sanitize_model(model: MakerWorldModel) -> MakerWorldModel {
    let images = model
        .images
        .into_iter()
        .filter_map(|value| sanitize_url_string(Some(value)))
        .take(8)
        .collect();
    let files = model
        .files
        .into_iter()
        .filter_map(|file| {
            let name = sanitize_required_string(file.name, 120)?;
            Some(MakerWorldFile {
                name,
                file_type: sanitize_optional_string(file.file_type, 24),
                download_url: sanitize_url_string(file.download_url),
            })
        })
        .take(16)
        .collect();

    MakerWorldModel {
        id: sanitize_optional_string(model.id, 64),
        title: sanitize_required_string(model.title, 160).unwrap_or_else(|| "MakerWorld Model".into()),
        author: sanitize_optional_string(model.author, 120),
        source_url: sanitize_url_string(Some(model.source_url)).unwrap_or_else(|| MAKERWORLD_HOME_URL.into()),
        rating: model.rating.map(|value| value.clamp(0.0, 5.0)),
        review_count: model.review_count,
        download_count: model.download_count,
        images,
        files,
    }
}

fn sanitize_required_string(value: String, max_len: usize) -> Option<String> {
    sanitize_optional_string(Some(value), max_len)
}

fn sanitize_optional_string(value: Option<String>, max_len: usize) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(max_len).collect())
        }
    })
}

fn sanitize_url_string(value: Option<String>) -> Option<String> {
    let value = sanitize_optional_string(value, 512)?;
    let parsed = Url::parse(&value).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    Some(parsed.to_string())
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for ch in value.chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }

    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "makerworld-model".into()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_page_kind, infer_download_filename, slugify};
    use crate::state::{MakerWorldModel, MAKERWORLD_HOME_URL, MakerWorldPageKind};
    use url::Url;

    #[test]
    fn classify_page_kind_matches_makerworld_routes() {
        assert_eq!(classify_page_kind(MAKERWORLD_HOME_URL), MakerWorldPageKind::Home);
        assert_eq!(
            classify_page_kind("https://makerworld.com/en/search/models?keyword=hook"),
            MakerWorldPageKind::Search
        );
        assert_eq!(
            classify_page_kind("https://makerworld.com/en/models/1073764-simple-headphone-hook"),
            MakerWorldPageKind::Model
        );
        assert_eq!(
            classify_page_kind("https://makerworld.com/en/challenges"),
            MakerWorldPageKind::Other
        );
    }

    #[test]
    fn slugify_creates_stable_folder_names() {
        assert_eq!(slugify("Simple Headphone Hook"), "simple-headphone-hook");
        assert_eq!(slugify("  ###  "), "makerworld-model");
    }

    #[test]
    fn infer_download_filename_prefers_url_segment_then_model_extension() {
        let url = Url::parse("https://makerworld.com/download/files/headphone-hook.3mf").unwrap();
        assert_eq!(infer_download_filename(&url, None), "headphone-hook.3mf");

        let model = MakerWorldModel {
            title: "Simple Headphone Hook".into(),
            files: vec![crate::state::MakerWorldFile {
                name: "Headphone Hook".into(),
                file_type: Some("3MF".into()),
                download_url: None,
            }],
            ..Default::default()
        };
        let opaque = Url::parse("https://makerworld.com/download?id=123").unwrap();
        assert_eq!(
            infer_download_filename(&opaque, Some(&model)),
            "simple-headphone-hook.3mf"
        );
    }
}
