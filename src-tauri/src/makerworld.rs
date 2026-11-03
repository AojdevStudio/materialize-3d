use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Webview, WebviewUrl,
    webview::{DownloadEvent, PageLoadEvent, WebviewBuilder},
};
use url::Url;

use crate::state::{
    AppState, MAKERWORLD_HOME_URL, MakerWorldBrowserState, MakerWorldFile, MakerWorldModel,
    MakerWorldPageKind, ModelImportStatus, ModelInfo,
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

/// What a download is for, captured when it starts. The finish files it under this, because the browser may show another model by then.
#[derive(Debug)]
struct DownloadStart {
    model_dir: PathBuf,
    model: Option<MakerWorldModel>,
    source_url: String,
}

#[derive(Debug)]
struct Reservation {
    destination: PathBuf,
    start: DownloadStart,
}

/// How many native transfers of one URL may run at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Overlap {
    /// WebKitGTK names the file on each successful finish, so transfers of one URL run side by side.
    Parallel,
    /// WKWebView names no file on any finish. A start of a URL that already has a transfer running is refused,
    /// and the running transfer serves it, so a pathless finish always belongs to the one reservation.
    OnePerUrl,
}

impl Overlap {
    const NATIVE: Self = if cfg!(target_os = "macos") { Self::OnePerUrl } else { Self::Parallel };
}

/// WKWebView reports a refused start within one round trip to its network process, if it reports it at all.
/// So under one transfer per URL a pathless failure inside this window after a refusal is that refusal's report,
/// and a refusal unreported for this long counts as never reported. The margin covers a busy main thread.
const REFUSAL_REPORT_WINDOW: Duration = Duration::from_secs(10);

/// What one finish event means for the import.
#[derive(Debug)]
enum Finished {
    Landed(Box<Reservation>),
    Failed,
    /// A success that names no single reservation.
    Unmatched,
    /// The finish of a start the app refused, which has nothing to report.
    Refused,
}

#[derive(Debug)]
struct PendingDownloads {
    overlap: Overlap,
    by_url: HashMap<String, UrlDownloads>,
    refused: HashMap<String, Vec<Instant>>,
}

impl Default for PendingDownloads {
    fn default() -> Self {
        Self::new(Overlap::NATIVE)
    }
}

/// The transfers of one URL that have not all finished.
#[derive(Debug, Default)]
struct UrlDownloads {
    reserved: Vec<Reservation>,
    in_flight: usize,
}

impl PendingDownloads {
    fn new(overlap: Overlap) -> Self {
        Self { overlap, by_url: HashMap::new(), refused: HashMap::new() }
    }

    /// Whether the overlap policy lets a start of the URL become a native transfer. It records a start it refuses.
    fn admit(&mut self, url: &str, now: Instant) -> bool {
        self.expire_refusals(now);
        let admitted = true;
        if !admitted {
            self.refuse(url, now);
        }
        admitted
    }

    /// Reserves a destination in the start's folder that no file and no other transfer holds. WebKitGTK and WebKit refuse an existing one.
    fn start(&mut self, url: &str, start: DownloadStart, filename: &str) -> PathBuf {
        let name = Path::new(filename);
        let stem = name.file_stem().unwrap_or(name.as_os_str()).to_string_lossy();
        let extension = name.extension().map(|extension| format!(".{}", extension.to_string_lossy()));
        let mut destination = start.model_dir.join(filename);
        for copy in 1.. {
            let taken = destination.exists()
                || self
                    .by_url
                    .values()
                    .flat_map(|downloads| &downloads.reserved)
                    .any(|reservation| reservation.destination == destination);
            if !taken {
                break;
            }
            destination =
                start.model_dir.join(format!("{stem} ({copy}){}", extension.as_deref().unwrap_or_default()));
        }

        let downloads = self.by_url.entry(url.into()).or_default();
        downloads.reserved.push(Reservation { destination: destination.clone(), start });
        downloads.in_flight += 1;
        destination
    }

    /// WebKitGTK reports a refused start as a pathless failure, which must not count against an accepted transfer.
    fn refuse(&mut self, url: &str, now: Instant) {
        self.refused.entry(url.into()).or_default().push(now);
    }

    fn expire_refusals(&mut self, now: Instant) {
        let _ = (now, REFUSAL_REPORT_WINDOW);
    }

    /// Takes back the oldest refusal of the URL whose report may still arrive.
    fn take_refusal(&mut self, url: &str) -> bool {
        let Some(refusals) = self.refused.get_mut(url) else { return false };
        refusals.remove(0);
        if refusals.is_empty() {
            self.refused.remove(url);
        }
        true
    }

    /// Resolves which reservation a finished transfer used and frees the URL once all its transfers finished.
    fn finish(&mut self, url: &str, path: Option<PathBuf>, success: bool, now: Instant) -> Finished {
        self.expire_refusals(now);
        if path.is_none() && !success && self.take_refusal(url) {
            return match self.overlap {
                // Linux reports a refused start as a failed download, as it did before macOS refused starts of its own.
                Overlap::Parallel => Finished::Failed,
                Overlap::OnePerUrl => Finished::Failed,
            };
        }
        let Some(downloads) = self.by_url.get_mut(url) else {
            return if success { Finished::Unmatched } else { Finished::Failed };
        };
        downloads.in_flight -= 1;
        let landed = match path {
            Some(path) => downloads
                .reserved
                .iter()
                .position(|reservation| reservation.destination == path)
                .map(|index| downloads.reserved.remove(index)),
            // A failed WebKitGTK finish and every macOS finish carry no path. Only a lone reservation names it.
            None if success && downloads.reserved.len() == 1 => downloads.reserved.pop(),
            None => None,
        };
        if downloads.in_flight == 0 {
            self.by_url.remove(url);
        }
        match (success, landed) {
            (true, Some(reservation)) => Finished::Landed(Box::new(reservation)),
            (true, None) => Finished::Unmatched,
            (false, _) => Finished::Failed,
        }
    }
}

#[derive(Clone, Default)]
pub struct MakerWorldService {
    pending_downloads: Arc<Mutex<PendingDownloads>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredImportMetadata {
    imported_at: String,
    source_url: String,
    model: Option<MakerWorldModel>,
    files: Vec<String>,
}

/// The parts of an existing `metadata.json` that a later download keeps.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredImportHistory {
    imported_at: Option<String>,
    #[serde(default)]
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
            let reserved = service
                .pending_downloads
                .lock()
                .map_err(|error| format!("failed to lock pending downloads: {error}"))
                .and_then(|mut pending| {
                    if !pending.admit(url.as_str(), Instant::now()) {
                        return Ok(None);
                    }
                    let (start, filename) = download_target(app, state, &url)?;
                    fs::create_dir_all(&start.model_dir)
                        .map_err(|error| format!("failed to create MakerWorld import directory: {error}"))?;
                    Ok(Some(pending.start(url.as_str(), start, &filename)))
                });
            match reserved {
                Ok(Some(path)) => {
                    *destination = path;
                    log::info!("makerworld download requested: {url}");
                }
                Ok(None) => {
                    log::info!("makerworld download of {url} is already running, so this start is refused");
                    return false;
                }
                Err(error) => {
                    log::warn!("failed to prepare makerworld download destination: {error}");
                    if let Ok(mut pending) = service.pending_downloads.lock() {
                        pending.refuse(url.as_str(), Instant::now());
                    }
                    if let Err(update_error) = set_import_error(app, state, error) {
                        log::warn!("failed to persist makerworld import error: {update_error}");
                    }
                    return false;
                }
            }
        }
        DownloadEvent::Finished { url, path, success } => {
            let outcome = service
                .pending_downloads
                .lock()
                .map_err(|error| format!("failed to lock pending downloads: {error}"))
                .and_then(|mut pending| match pending.finish(url.as_str(), path, success, Instant::now()) {
                    Finished::Landed(reservation) => Ok(Some(*reservation)),
                    Finished::Refused => Ok(None),
                    Finished::Failed => Err(format!("MakerWorld download failed for {url}")),
                    Finished::Unmatched => Err("MakerWorld download finished without a recorded start".into()),
                })
                .and_then(|landed| landed.map_or(Ok(()), |reservation| finalize_import(app, state, reservation)));
            if let Err(error) = outcome {
                if let Err(update_error) = set_import_error(app, state, error) {
                    log::warn!("failed to record MakerWorld import error: {update_error}");
                }
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
    Reservation { destination, start }: Reservation,
) -> Result<(), String> {
    let downloaded_path = destination.canonicalize().unwrap_or(destination);

    persist_import_metadata(&start.model_dir, &start.source_url, start.model.clone(), &downloaded_path)?;

    {
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
        workspace.active_model = Some(ModelInfo {
            id: start.model.as_ref().and_then(|model| model.id.clone()),
            name: start
                .model
                .map(|model| model.title)
                .unwrap_or_else(|| file_stem_or_name(&downloaded_path)),
            path: Some(next_path),
            source: Some(start.source_url),
            size_bytes: fs::metadata(&downloaded_path).ok().map(|meta| meta.len()),
        });
    }

    let added = add_import_to_library(app, state, &start.model_dir);
    state.emit_state_change(app, "workspace:changed")?;
    added
}

fn add_import_to_library<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    model_dir: &Path,
) -> Result<(), String> {
    {
        let db = state
            .db
            .lock()
            .map_err(|error| format!("failed to lock db: {error}"))?;
        let conn = db.as_ref().ok_or_else(|| "database not initialized".to_string())?;
        crate::database::index_library_folder(conn, model_dir)?;
    }
    crate::commands::emit_library_changed(app, state);
    Ok(())
}

/// The folder keeps the files an earlier download listed there, so a later app session adds to them.
fn persist_import_metadata(
    model_dir: &Path,
    source_url: &str,
    model: Option<MakerWorldModel>,
    downloaded_path: &Path,
) -> Result<(), String> {
    let model_dir = model_dir
        .canonicalize()
        .map_err(|error| format!("failed to resolve makerworld model directory: {error}"))?;
    let metadata_path = model_dir.join("metadata.json");

    let history = match fs::read(&metadata_path) {
        Ok(raw) => serde_json::from_slice::<StoredImportHistory>(&raw)
            .map_err(|error| format!("failed to parse '{}': {error}", metadata_path.display()))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredImportHistory {
            imported_at: None,
            files: Vec::new(),
        },
        Err(error) => return Err(format!("failed to read '{}': {error}", metadata_path.display())),
    };

    let mut files = Vec::new();
    for file in history.files.into_iter().map(PathBuf::from).chain([downloaded_path.to_path_buf()]) {
        let file = model_dir.join(file);
        let listed = file.to_string_lossy().to_string();
        if file.parent() == Some(model_dir.as_path()) && !files.contains(&listed) {
            files.push(listed);
        }
    }

    let metadata = StoredImportMetadata {
        imported_at: history.imported_at.unwrap_or_else(|| Utc::now().to_rfc3339()),
        source_url: source_url.into(),
        model,
        files,
    };
    fs::write(
        metadata_path,
        serde_json::to_vec_pretty(&metadata)
            .map_err(|error| format!("failed to serialize makerworld metadata: {error}"))?,
    )
    .map_err(|error| format!("failed to write makerworld metadata: {error}"))
}

fn download_target<R: Runtime>(
    app: &AppHandle<R>,
    state: &Arc<AppState>,
    url: &Url,
) -> Result<(DownloadStart, String), String> {
    let library_dir = library_root(app)?;
    let workspace = state
        .workspace
        .lock()
        .map_err(|error| format!("failed to lock workspace state: {error}"))?;
    Ok(download_start(&library_dir, &workspace.makerworld, url))
}

fn download_start(library_dir: &Path, makerworld: &MakerWorldBrowserState, url: &Url) -> (DownloadStart, String) {
    let model = makerworld.detected_model.clone();
    let folder_name = model
        .as_ref()
        .map(|model| match model.id.as_deref() {
            Some(id) if !id.is_empty() => format!("{}-{}", slugify(&model.title), id),
            _ => slugify(&model.title),
        })
        .unwrap_or_else(|| slugify("makerworld-import"));
    let filename = infer_download_filename(url, model.as_ref());
    let start = DownloadStart {
        model_dir: library_dir.join(folder_name),
        source_url: model
            .as_ref()
            .map(|model| model.source_url.clone())
            .unwrap_or_else(|| makerworld.current_url.clone()),
        model,
    };
    (start, filename)
}

fn infer_download_filename(url: &Url, model: Option<&MakerWorldModel>) -> String {
    if let Some(segment) = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
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
        rating: model.rating.filter(|value| (0.0..=5.0).contains(value)),
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

#[cfg(all(test, target_os = "linux"))]
mod webkitgtk_downloads;

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        time::Instant,
    };

    use super::{
        classify_page_kind, infer_download_filename, sanitize_model, slugify, DownloadStart, Finished, Overlap,
        PendingDownloads, REFUSAL_REPORT_WINDOW,
    };
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
    fn sanitize_model_drops_a_rating_outside_zero_to_five() {
        let with_rating = |rating| MakerWorldModel {
            title: "Onion & Potato Dispenser".into(),
            source_url: "https://makerworld.com/en/models/2133969".into(),
            rating: Some(rating),
            ..Default::default()
        };

        assert_eq!(sanitize_model(with_rating(4.9)).rating, Some(4.9));
        assert_eq!(sanitize_model(with_rating(233.0)).rating, None);
        assert_eq!(sanitize_model(with_rating(-1.0)).rating, None);
    }

    fn start_in(folder: &Path) -> DownloadStart {
        DownloadStart { model_dir: folder.into(), model: None, source_url: String::new() }
    }

    fn landed(finished: Finished) -> Option<PathBuf> {
        match finished {
            Finished::Landed(reservation) => Some(reservation.destination),
            _ => None,
        }
    }

    fn reserved(pending: &PendingDownloads, url: &str) -> Vec<PathBuf> {
        pending.by_url[url].reserved.iter().map(|reservation| reservation.destination.clone()).collect()
    }

    #[test]
    fn a_pathless_finish_names_its_file_only_while_the_url_holds_one_reservation() {
        let downloads = tempfile::tempdir().unwrap();
        let first = downloads.path().join("first");
        let mut pending = PendingDownloads::new(Overlap::Parallel);
        let url = "https://makerworld.com/download/files/hook.3mf";
        let now = Instant::now();

        assert_eq!(pending.start(url, start_in(&first), "hook.3mf"), first.join("hook.3mf"));
        assert_eq!(landed(pending.finish(url, None, true, now)), Some(first.join("hook.3mf")));
        assert!(pending.by_url.is_empty());

        pending.start(url, start_in(&first), "hook.3mf");
        assert_eq!(pending.start(url, start_in(&first), "hook.3mf"), first.join("hook (1).3mf"));
        assert_eq!(landed(pending.finish(url, None, true, now)), None, "two transfers, a pathless finish is not guessed");
        assert_eq!(landed(pending.finish(url, None, true, now)), None);
        assert!(pending.by_url.is_empty());
    }

    #[test]
    fn a_refused_start_leaves_the_accepted_transfer_of_its_url_pending() {
        let downloads = tempfile::tempdir().unwrap();
        let mut pending = PendingDownloads::new(Overlap::Parallel);
        let url = "https://makerworld.com/download/files/hook.3mf";
        let now = Instant::now();

        let accepted = pending.start(url, start_in(downloads.path()), "hook.3mf");
        pending.refuse(url, now);
        assert_eq!(landed(pending.finish(url, None, false, now)), None);
        assert_eq!(reserved(&pending, url), vec![accepted.clone()]);

        let later = pending.start(url, start_in(downloads.path()), "hook.3mf");
        assert_eq!(later, downloads.path().join("hook (1).3mf"), "the accepted transfer still holds its name");
        assert_eq!(landed(pending.finish(url, Some(accepted.clone()), true, now)), Some(accepted));
        assert_eq!(landed(pending.finish(url, Some(later.clone()), true, now)), Some(later));
        assert!(pending.by_url.is_empty());

        pending.refuse(url, now);
        let retry = pending.start(url, start_in(downloads.path()), "fresh.3mf");
        assert_eq!(landed(pending.finish(url, None, false, now)), None, "the refusal fails before the retry");
        assert_eq!(reserved(&pending, url), vec![retry.clone()], "a refused first start is not charged to a retry");
        assert_eq!(landed(pending.finish(url, Some(retry.clone()), true, now)), Some(retry));
        assert!(pending.by_url.is_empty() && pending.refused.is_empty());
    }

    const HOOK: &str = "https://makerworld.com/download/files/hook.3mf";

    fn request(pending: &mut PendingDownloads, folder: &Path, now: Instant) -> Option<PathBuf> {
        pending.admit(HOOK, now).then(|| pending.start(HOOK, start_in(folder), "hook.3mf"))
    }

    #[test]
    fn one_per_url_refuses_a_second_start_while_the_url_runs_and_lands_the_pathless_finish_in_the_first() {
        let downloads = tempfile::tempdir().unwrap();
        let mut pending = PendingDownloads::new(Overlap::OnePerUrl);
        let now = Instant::now();

        let running = request(&mut pending, downloads.path(), now);
        assert_eq!(running, Some(downloads.path().join("hook.3mf")));
        assert_eq!(request(&mut pending, downloads.path(), now), None, "no second native download");
        assert!(matches!(pending.finish(HOOK, None, false, now), Finished::Refused), "the refused start reports nothing");
        assert_eq!(landed(pending.finish(HOOK, None, true, now)), running, "the pathless success is the running transfer");
        assert!(pending.by_url.is_empty() && pending.refused.is_empty());

        assert!(request(&mut pending, downloads.path(), now).is_some(), "the URL takes a new start");
    }

    #[test]
    fn one_per_url_charges_a_late_refusal_report_to_the_refusal_not_to_a_newer_transfer() {
        let downloads = tempfile::tempdir().unwrap();
        let mut pending = PendingDownloads::new(Overlap::OnePerUrl);
        let now = Instant::now();

        let running = request(&mut pending, downloads.path(), now);
        assert_eq!(request(&mut pending, downloads.path(), now), None);
        assert_eq!(landed(pending.finish(HOOK, None, true, now)), running);
        let newer = request(&mut pending, downloads.path(), now);
        assert!(newer.is_some());

        assert!(matches!(pending.finish(HOOK, None, false, now), Finished::Refused), "the report of the refusal");
        assert_eq!(landed(pending.finish(HOOK, None, true, now)), newer, "the newer transfer keeps its reservation");
        assert!(pending.by_url.is_empty() && pending.refused.is_empty());
    }

    #[test]
    fn one_per_url_fails_the_running_transfer_and_its_refused_start_in_either_order() {
        let downloads = tempfile::tempdir().unwrap();
        let mut pending = PendingDownloads::new(Overlap::OnePerUrl);
        let now = Instant::now();

        request(&mut pending, downloads.path(), now).unwrap();
        assert_eq!(request(&mut pending, downloads.path(), now), None);
        let finishes = [pending.finish(HOOK, None, false, now), pending.finish(HOOK, None, false, now)];
        assert_eq!(
            finishes.iter().filter(|finished| matches!(finished, Finished::Failed)).count(),
            1,
            "one failure for the transfer, nothing for the refusal: {finishes:?}",
        );
        assert!(pending.by_url.is_empty() && pending.refused.is_empty());
    }

    #[test]
    fn one_per_url_reports_a_failure_once_an_unreported_refusal_is_past_its_window() {
        let downloads = tempfile::tempdir().unwrap();
        let mut pending = PendingDownloads::new(Overlap::OnePerUrl);
        let refused_at = Instant::now();
        let later = refused_at + REFUSAL_REPORT_WINDOW;

        request(&mut pending, downloads.path(), refused_at).unwrap();
        assert_eq!(request(&mut pending, downloads.path(), refused_at), None);
        assert!(matches!(pending.finish(HOOK, None, false, later), Finished::Failed), "the running transfer failed");
        assert!(request(&mut pending, downloads.path(), later).is_some(), "a retry starts");
        assert!(matches!(pending.finish(HOOK, None, false, later), Finished::Failed));

        pending.refuse(HOOK, refused_at);
        request(&mut pending, downloads.path(), later).unwrap();
        assert!(matches!(pending.finish(HOOK, None, false, later), Finished::Failed), "a refusal with nothing running");
        assert!(matches!(pending.finish(HOOK, None, false, later), Finished::Failed), "a failure with nothing reserved");
        assert!(pending.by_url.is_empty() && pending.refused.is_empty());
    }

    #[test]
    fn one_per_url_keeps_no_unreported_refusal_past_its_window_when_every_transfer_lands() {
        let downloads = tempfile::tempdir().unwrap();
        let mut pending = PendingDownloads::new(Overlap::OnePerUrl);
        let refused_at = Instant::now();

        let running = request(&mut pending, downloads.path(), refused_at);
        assert_eq!(request(&mut pending, downloads.path(), refused_at), None);
        assert_eq!(landed(pending.finish(HOOK, None, true, refused_at)), running);
        let later = request(&mut pending, downloads.path(), refused_at + REFUSAL_REPORT_WINDOW);
        assert_eq!(landed(pending.finish(HOOK, None, true, refused_at + REFUSAL_REPORT_WINDOW)), later);
        assert!(pending.by_url.is_empty() && pending.refused.is_empty(), "{:?}", pending.refused);
    }

    #[test]
    fn only_macos_runs_one_native_transfer_per_url() {
        let downloads = tempfile::tempdir().unwrap();
        let mut pending = PendingDownloads::default();
        let now = Instant::now();

        request(&mut pending, downloads.path(), now).unwrap();
        let second = request(&mut pending, downloads.path(), now);
        assert_eq!(second.is_none(), cfg!(target_os = "macos"), "{second:?}");
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

    mod library_import {
        use std::{
            path::{Path, PathBuf},
            sync::{Arc, Mutex},
        };

        use tauri::{
            test::{mock_builder, mock_context, noop_assets, MockRuntime},
            webview::DownloadEvent,
            App, Listener, Webview, WebviewUrl, WebviewWindowBuilder,
        };
        use url::Url;

        use super::super::{
            download_start, finalize_import, handle_download, MakerWorldService, Overlap, PendingDownloads, Reservation,
        };
        use crate::database;
        use crate::state::{AppState, LibraryModel, MakerWorldBrowserState, MakerWorldModel, ModelImportStatus};

        struct Session {
            app: App<MockRuntime>,
            webview: Webview<MockRuntime>,
            state: Arc<AppState>,
            service: MakerWorldService,
            library_events: Arc<Mutex<Vec<Vec<LibraryModel>>>>,
            library_dir: tempfile::TempDir,
        }

        fn dispenser() -> MakerWorldModel {
            MakerWorldModel {
                id: Some("2311143".into()),
                title: "Onion & Potato Dispenser".into(),
                author: Some("Maker".into()),
                source_url: "https://makerworld.com/en/models/2311143".into(),
                images: vec!["https://example.com/dispenser.jpg".into()],
                ..Default::default()
            }
        }

        fn hook() -> MakerWorldModel {
            MakerWorldModel {
                id: Some("1073764".into()),
                title: "Simple Headphone Hook".into(),
                source_url: "https://makerworld.com/en/models/1073764".into(),
                ..Default::default()
            }
        }

        fn session_on_the_dispenser() -> Session {
            let app = mock_builder().build(mock_context(noop_assets())).expect("mock app");
            let webview = WebviewWindowBuilder::new(app.handle(), "makerworld", WebviewUrl::default())
                .build()
                .unwrap()
                .as_ref()
                .clone();
            let state = Arc::new(AppState::default());
            *state.db.lock().unwrap() = Some(database::init_db(Path::new(":memory:")).unwrap());
            browse_to(&state, Some(dispenser()));

            let library_events = Arc::new(Mutex::new(Vec::new()));
            let sink = library_events.clone();
            app.listen_any("library:changed", move |event| {
                sink.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
            });

            Session {
                app,
                webview,
                state,
                service: service(Overlap::Parallel),
                library_events,
                library_dir: tempfile::tempdir().unwrap(),
            }
        }

        fn restart(session: Session) -> Session {
            let state = Arc::new(AppState::default());
            *state.db.lock().unwrap() = session.state.db.lock().unwrap().take();
            browse_to(&state, Some(dispenser()));
            Session { state, service: service(Overlap::Parallel), ..session }
        }

        fn service(overlap: Overlap) -> MakerWorldService {
            MakerWorldService { pending_downloads: Arc::new(Mutex::new(PendingDownloads::new(overlap))) }
        }

        fn browse_to(state: &AppState, model: Option<MakerWorldModel>) {
            state.workspace.lock().unwrap().makerworld.detected_model = model;
        }

        fn url_of(file_name: &str) -> Url {
            Url::parse(&format!("https://makerworld.com/download/files/{file_name}")).unwrap()
        }

        fn makerworld(session: &Session) -> MakerWorldBrowserState {
            session.state.workspace.lock().unwrap().makerworld.clone()
        }

        /// The `Requested` arm with the library in a temp folder, and the transferred file already written.
        fn start(session: &Session, file_name: &str) -> PathBuf {
            let url = url_of(file_name);
            let (start, filename) = download_start(session.library_dir.path(), &makerworld(session), &url);
            std::fs::create_dir_all(&start.model_dir).unwrap();
            let destination = session.service.pending_downloads.lock().unwrap().start(url.as_str(), start, &filename);
            std::fs::write(&destination, b"zip").unwrap();
            destination
        }

        fn finish(session: &Session, file_name: &str, path: Option<PathBuf>) {
            let event = DownloadEvent::Finished { url: url_of(file_name), path, success: true };
            assert!(handle_download(session.webview.clone(), event, session.app.handle(), &session.state, &session.service));
        }

        fn download(session: &Session, file_name: &str) -> PathBuf {
            let file = start(session, file_name);
            finish(session, file_name, Some(file.clone()));
            assert_eq!(makerworld(session).import_status, ModelImportStatus::Imported, "{:?}", makerworld(session));
            file
        }

        fn finalize_again(session: &Session, file: &Path) {
            let url = url_of(&file.file_name().unwrap().to_string_lossy());
            let (start, _) = download_start(session.library_dir.path(), &makerworld(session), &url);
            finalize_import(session.app.handle(), &session.state, Reservation { destination: file.into(), start }).unwrap();
        }

        fn metadata(file: &Path) -> serde_json::Value {
            let raw = std::fs::read_to_string(file.parent().unwrap().join("metadata.json")).unwrap();
            serde_json::from_str(&raw).unwrap()
        }

        fn metadata_files(file: &Path) -> Vec<String> {
            metadata(file)["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| path.as_str().unwrap().to_string())
                .collect()
        }

        fn path_of(file: &Path) -> String {
            file.canonicalize().unwrap().to_string_lossy().to_string()
        }

        fn library(state: &AppState) -> Vec<LibraryModel> {
            database::get_all_library_models(state.db.lock().unwrap().as_ref().unwrap()).unwrap()
        }

        #[test]
        fn a_finished_download_appears_in_the_library_once() {
            let session = session_on_the_dispenser();
            let earlier = LibraryModel {
                id: "earlier".into(),
                model_name: "Earlier Import".into(),
                author: None,
                source_url: None,
                imported_at: "2026-01-01T00:00:00Z".into(),
                thumbnail_url: None,
                file_path: None,
                folder_path: "/library/earlier-import".into(),
                rating: None,
                download_count: None,
                file_count: None,
            };
            database::upsert_library_model(session.state.db.lock().unwrap().as_ref().unwrap(), &earlier).unwrap();

            let file = download(&session, "dispenser.zip");

            let rows = library(&session.state);
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[1], earlier);
            assert_eq!(rows[0].model_name, "Onion & Potato Dispenser");
            assert_eq!(rows[0].author.as_deref(), Some("Maker"));
            assert_eq!(rows[0].source_url.as_deref(), Some("https://makerworld.com/en/models/2311143"));
            assert_eq!(*session.library_events.lock().unwrap(), vec![rows.clone()]);

            finalize_again(&session, &file);

            assert_eq!(library(&session.state), rows);
            assert_eq!(session.library_events.lock().unwrap().len(), 2);
        }

        #[test]
        fn the_launch_scan_builds_the_same_row_as_the_download() {
            let session = session_on_the_dispenser();
            download(&session, "dispenser.zip");
            let launched = AppState::default();
            *launched.db.lock().unwrap() = Some(database::init_db(Path::new(":memory:")).unwrap());

            let scanned = database::scan_library_filesystem(
                launched.db.lock().unwrap().as_ref().unwrap(),
                session.library_dir.path(),
            )
            .unwrap();

            let without_id = |rows: Vec<LibraryModel>| {
                rows.into_iter().map(|row| LibraryModel { id: String::new(), ..row }).collect::<Vec<_>>()
            };
            assert_eq!(scanned, 1);
            assert_eq!(without_id(library(&launched)), without_id(library(&session.state)));
        }

        #[test]
        fn each_model_downloaded_in_a_session_lists_only_its_own_file() {
            let session = session_on_the_dispenser();
            let dispenser_file = download(&session, "dispenser.zip");
            browse_to(&session.state, Some(hook()));
            let hook_file = download(&session, "hook.3mf");

            assert_eq!(metadata_files(&dispenser_file), vec![path_of(&dispenser_file)]);
            assert_eq!(metadata_files(&hook_file), vec![path_of(&hook_file)]);

            let rows = library(&session.state);
            let row_of = |name: &str| rows.iter().find(|row| row.model_name == name).unwrap();
            let dispenser_row = row_of("Onion & Potato Dispenser");
            assert_eq!(dispenser_row.file_path, Some(path_of(&dispenser_file)));
            assert_eq!(dispenser_row.file_count, Some(1));
            let hook_row = row_of("Simple Headphone Hook");
            assert_eq!(hook_row.file_path, Some(path_of(&hook_file)));
            assert_eq!(hook_row.file_count, Some(1));
        }

        #[test]
        fn a_model_keeps_each_download_of_a_session_once() {
            let session = session_on_the_dispenser();
            let dispenser_file = download(&session, "dispenser.zip");
            browse_to(&session.state, Some(hook()));
            let hook_file = download(&session, "hook.3mf");
            browse_to(&session.state, Some(dispenser()));
            let second_plate = download(&session, "dispenser-plate-2.zip");
            finalize_again(&session, &second_plate);

            assert_eq!(metadata_files(&dispenser_file), vec![path_of(&dispenser_file), path_of(&second_plate)]);
            assert_eq!(metadata_files(&hook_file), vec![path_of(&hook_file)]);
        }

        #[test]
        fn a_download_lands_under_the_model_it_started_on() {
            for later_page in [Some(hook()), None] {
                for with_path in [true, false] {
                    let session = session_on_the_dispenser();
                    let file = start(&session, "dispenser.zip");
                    browse_to(&session.state, later_page.clone());

                    finish(&session, "dispenser.zip", with_path.then(|| file.clone()));

                    let case = format!("later page {:?}, path {with_path}", later_page.as_ref().map(|model| &model.title));
                    assert_eq!(makerworld(&session).import_status, ModelImportStatus::Imported, "{case}");
                    assert_eq!(metadata(&file)["model"]["title"], "Onion & Potato Dispenser", "{case}");
                    assert_eq!(metadata_files(&file), vec![path_of(&file)], "{case}");
                    let rows = library(&session.state);
                    assert_eq!(rows.len(), 1, "{case}");
                    assert_eq!(rows[0].model_name, "Onion & Potato Dispenser", "{case}");
                    assert_eq!(rows[0].file_count, Some(1), "{case}");
                }
            }
        }

        #[test]
        fn overlapping_starts_of_one_url_on_two_models_each_land_under_their_own_model() {
            let session = session_on_the_dispenser();
            let on_dispenser = start(&session, "shared.3mf");
            browse_to(&session.state, Some(hook()));
            let on_hook = start(&session, "shared.3mf");

            finish(&session, "shared.3mf", Some(on_hook.clone()));
            finish(&session, "shared.3mf", Some(on_dispenser.clone()));

            for (file, title) in [(&on_dispenser, "Onion & Potato Dispenser"), (&on_hook, "Simple Headphone Hook")] {
                assert_eq!(metadata(file)["model"]["title"], title);
                assert_eq!(metadata_files(file), vec![path_of(file)]);
            }
            let rows = library(&session.state);
            assert_eq!(rows.len(), 2);
            assert!(rows.iter().all(|row| row.file_count == Some(1)), "{rows:?}");
            assert!(session.service.pending_downloads.lock().unwrap().by_url.is_empty());
        }

        #[test]
        fn a_later_start_that_lands_while_the_first_fails_is_filed_under_its_own_model() {
            let session = session_on_the_dispenser();
            let on_dispenser = start(&session, "shared.3mf");
            browse_to(&session.state, Some(hook()));
            let on_hook = start(&session, "shared.3mf");
            std::fs::remove_file(&on_dispenser).unwrap();

            finish(&session, "shared.3mf", Some(on_hook.clone()));
            let failed = DownloadEvent::Finished { url: url_of("shared.3mf"), path: None, success: false };
            handle_download(session.webview.clone(), failed, session.app.handle(), &session.state, &session.service);

            assert_eq!(metadata(&on_hook)["model"]["title"], "Simple Headphone Hook");
            assert_eq!(metadata_files(&on_hook), vec![path_of(&on_hook)]);
            assert!(!on_dispenser.with_file_name("metadata.json").exists());
            let rows = library(&session.state);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].model_name, "Simple Headphone Hook");
            assert!(session.service.pending_downloads.lock().unwrap().by_url.is_empty());
        }

        #[test]
        fn on_one_transfer_per_url_a_refused_duplicate_shows_no_error_and_the_running_download_lands() {
            let session = Session { service: service(Overlap::OnePerUrl), ..session_on_the_dispenser() };
            let file = start(&session, "dispenser.zip");
            let mut destination = PathBuf::from("untouched");
            let requested = DownloadEvent::Requested { url: url_of("dispenser.zip"), destination: &mut destination };
            assert!(
                !handle_download(session.webview.clone(), requested, session.app.handle(), &session.state, &session.service),
                "WebKit is told to refuse the second native download",
            );
            assert_eq!(destination, PathBuf::from("untouched"));

            let refused = DownloadEvent::Finished { url: url_of("dispenser.zip"), path: None, success: false };
            handle_download(session.webview.clone(), refused, session.app.handle(), &session.state, &session.service);
            assert_eq!(makerworld(&session).last_extraction_error, None);
            finish(&session, "dispenser.zip", None);

            let makerworld = makerworld(&session);
            assert_eq!(makerworld.import_status, ModelImportStatus::Imported, "{makerworld:?}");
            assert_eq!(metadata_files(&file), vec![path_of(&file)]);
            assert_eq!(library(&session.state).len(), 1);
            assert!(session.service.pending_downloads.lock().unwrap().by_url.is_empty());
        }

        #[test]
        fn a_success_with_no_reservation_is_an_import_error() {
            let session = session_on_the_dispenser();
            let file = start(&session, "dispenser.zip");
            let elsewhere = file.with_file_name("elsewhere.zip");
            std::fs::write(&elsewhere, b"zip").unwrap();

            finish(&session, "dispenser.zip", Some(elsewhere));

            let makerworld = makerworld(&session);
            assert_eq!(makerworld.import_status, ModelImportStatus::Error);
            assert_eq!(makerworld.last_extraction_error.as_deref(), Some("MakerWorld download finished without a recorded start"));
            assert!(library(&session.state).is_empty());
        }

        #[test]
        fn a_later_session_adds_its_download_to_the_model_in_the_library() {
            let session = session_on_the_dispenser();
            let plate_1 = download(&session, "dispenser-plate-1.zip");
            let row_id = library(&session.state)[0].id.clone();

            let session = restart(session);
            let plate_2 = download(&session, "dispenser-plate-2.zip");

            assert_eq!(metadata_files(&plate_2), vec![path_of(&plate_1), path_of(&plate_2)]);
            let rows = library(&session.state);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].id, row_id);
            assert_eq!(rows[0].file_count, Some(2));
            assert_eq!(session.library_events.lock().unwrap().last(), Some(&rows));
        }

        #[test]
        fn a_download_into_a_folder_with_malformed_metadata_shows_the_error_and_leaves_it_untouched() {
            let session = session_on_the_dispenser();
            let file = start(&session, "dispenser.zip");
            let metadata_path = file.with_file_name("metadata.json");
            std::fs::write(&metadata_path, "not json").unwrap();

            finish(&session, "dispenser.zip", Some(file));

            let makerworld = makerworld(&session);
            assert_eq!(makerworld.import_status, ModelImportStatus::Error);
            let error = makerworld.last_extraction_error.unwrap();
            assert!(error.contains("failed to parse"), "{error}");
            assert_eq!(std::fs::read_to_string(&metadata_path).unwrap(), "not json");
            assert!(library(&session.state).is_empty());
        }
    }
}
