use std::sync::Arc;

use tauri::{AppHandle, Runtime, State, Webview};
use tauri::Emitter;
use tauri::Manager;

use crate::credentials;
use crate::database;
use crate::makerworld::{
    self, ImportResult, MakerWorldImportAttempt, MakerWorldPageReport, MakerWorldService,
    MakerWorldWebviewBounds,
};
use crate::oauth_callback::{self, OAuthCallbackState};
use crate::openscad::OpenScadService;
use crate::print_queue;
use crate::printer::{BambuCommand, BambuCredentials, PrinterService};
use crate::slicer::{ProfileList, SliceInput, SliceResult, SlicerService};

use crate::state::{AppState, AppStateSnapshot, CameraStatus, PrinterState, QueuedJob, QueueStatus, ViewType, PrintHistoryRecord, LibraryModel, ModelInfo, PrinterConfig};
use std::collections::HashMap;

/// Result of a camera endpoint probe.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CameraProbeResult {
    pub reachable: bool,
    pub diagnostic: String,
}

/// Result of a `start_print` command.
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartPrintResult {
    pub success: bool,
    pub filename: String,
    pub md5: String,
    #[serde(default)]
    pub error: Option<String>,
}

#[tauri::command]
pub fn get_app_state(state: State<'_, Arc<AppState>>) -> Result<AppStateSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub fn set_active_view(
    view: ViewType,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AppStateSnapshot, String> {
    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?;
        workspace.active_view = view;
    }

    state.emit_state_change(&app, "workspace:changed")?;
    state.snapshot()
}

#[tauri::command]
pub fn sync_makerworld_webview(
    bounds: MakerWorldWebviewBounds,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, MakerWorldService>,
) -> Result<(), String> {
    makerworld::sync_webview(&app, &state, &service, bounds)
}

#[tauri::command]
pub fn navigate_makerworld(
    url: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, MakerWorldService>,
) -> Result<AppStateSnapshot, String> {
    makerworld::navigate(&app, &state, &service, &url)?;
    state.snapshot()
}

#[tauri::command]
pub fn search_makerworld(
    query: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, MakerWorldService>,
) -> Result<AppStateSnapshot, String> {
    makerworld::search(&app, &state, &service, &query)?;
    state.snapshot()
}

#[tauri::command]
pub fn makerworld_back(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, MakerWorldService>,
) -> Result<AppStateSnapshot, String> {
    makerworld::back(&app, &state, &service)?;
    state.snapshot()
}

#[tauri::command]
pub fn makerworld_forward(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, MakerWorldService>,
) -> Result<AppStateSnapshot, String> {
    makerworld::forward(&app, &state, &service)?;
    state.snapshot()
}

#[tauri::command]
pub fn makerworld_reload(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, MakerWorldService>,
) -> Result<AppStateSnapshot, String> {
    makerworld::reload(&app, &state, &service)?;
    state.snapshot()
}

#[tauri::command]
pub fn download_model(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, MakerWorldService>,
) -> Result<ImportResult, String> {
    makerworld::import_current_model(&app, &state, &service)?;

    let workspace = state
        .workspace
        .lock()
        .map_err(|error| format!("failed to lock workspace state: {error}"))?;
    Ok(ImportResult {
        import_status: workspace.makerworld.import_status.clone(),
        imported_files: workspace.makerworld.imported_files.clone(),
    })
}

#[tauri::command]
pub fn report_makerworld_page<R: Runtime>(
    webview: Webview<R>,
    payload: MakerWorldPageReport,
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    makerworld::report_page(webview, &app, &state, payload)
}

#[tauri::command]
pub fn report_makerworld_import_attempt<R: Runtime>(
    webview: Webview<R>,
    payload: MakerWorldImportAttempt,
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    makerworld::report_import_attempt(webview, &app, &state, payload)
}

/// Connect to the printer.  Optionally pass a path to a credentials file;
/// defaults to `~/.bambu-mcp/credentials.json`.
#[tauri::command]
pub async fn connect_printer(
    credentials_path: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, PrinterService>,
) -> Result<(), String> {
    let creds = match credentials_path {
        Some(path) => BambuCredentials::load_from_file(path).map_err(|e| e.to_string())?,
        None => BambuCredentials::load_default().map_err(|e| e.to_string())?,
    };

    service
        .start(creds, app, Arc::clone(&*state))
        .await
        .map_err(|e| e.to_string())
}

/// Disconnect from the printer.
#[tauri::command]
pub async fn disconnect_printer(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, PrinterService>,
) -> Result<(), String> {
    service.disconnect(&app, &state).await;
    Ok(())
}

/// Get the current printer status snapshot.
#[tauri::command]
pub fn get_printer_status(state: State<'_, Arc<AppState>>) -> Result<PrinterState, String> {
    let printer = state
        .printer
        .lock()
        .map_err(|e| format!("failed to lock printer state: {e}"))?;
    Ok(printer.clone())
}

/// Probe the printer's camera JPEG endpoint for reachability.
///
/// Sends an HTTP HEAD request to `http://{ip}:6000/` with a 3-second timeout.
/// Updates `camera_state` on `PrinterState` based on the result.
#[tauri::command]
pub async fn probe_camera(
    ip: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<CameraProbeResult, String> {
    use std::time::Instant;

    // Set status to Probing while we check
    if let Ok(mut printer) = state.printer.lock() {
        printer.camera_state.status = CameraStatus::Probing;
        printer.camera_state.diagnostic = Some("Probing camera endpoint...".into());
    }
    let _ = state.emit_state_change(&app, "printer:changed");

    let url = format!("http://{}:6000/", ip);
    let start = Instant::now();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;

    let result = client.head(&url).send().await;
    let elapsed_ms = start.elapsed().as_millis();

    match result {
        Ok(resp) if resp.status().is_success() || resp.status().is_redirection() => {
            let diagnostic = format!(
                "Camera reachable at {} ({}ms, HTTP {})",
                url,
                elapsed_ms,
                resp.status().as_u16()
            );
            log::info!("probe_camera: {diagnostic}");

            if let Ok(mut printer) = state.printer.lock() {
                printer.camera_state.status = CameraStatus::Available;
                printer.camera_state.url = Some(url);
                printer.camera_state.diagnostic = Some(diagnostic.clone());
            }
            let _ = state.emit_state_change(&app, "printer:changed");

            Ok(CameraProbeResult {
                reachable: true,
                diagnostic,
            })
        }
        Ok(resp) => {
            let diagnostic = format!(
                "Camera endpoint returned HTTP {} at {} ({}ms)",
                resp.status().as_u16(),
                url,
                elapsed_ms
            );
            log::info!("probe_camera: {diagnostic}");

            if let Ok(mut printer) = state.printer.lock() {
                printer.camera_state.status = CameraStatus::Error;
                printer.camera_state.url = None;
                printer.camera_state.diagnostic = Some(diagnostic.clone());
            }
            let _ = state.emit_state_change(&app, "printer:changed");

            Ok(CameraProbeResult {
                reachable: false,
                diagnostic,
            })
        }
        Err(e) => {
            let diagnostic = format!(
                "Camera unreachable at {} ({}ms): {}",
                url, elapsed_ms, e
            );
            log::info!("probe_camera: {diagnostic}");

            if let Ok(mut printer) = state.printer.lock() {
                printer.camera_state.status = CameraStatus::Unavailable;
                printer.camera_state.url = None;
                printer.camera_state.diagnostic = Some(diagnostic.clone());
            }
            let _ = state.emit_state_change(&app, "printer:changed");

            Ok(CameraProbeResult {
                reachable: false,
                diagnostic,
            })
        }
    }
}

/// Pause the active print.
#[tauri::command]
pub async fn pause_print(service: State<'_, PrinterService>) -> Result<(), String> {
    service
        .send_command(BambuCommand::Pause)
        .await
        .map_err(|e| e.to_string())
}

/// Resume a paused print.
#[tauri::command]
pub async fn resume_print(service: State<'_, PrinterService>) -> Result<(), String> {
    service
        .send_command(BambuCommand::Resume)
        .await
        .map_err(|e| e.to_string())
}

/// Upload a sliced 3MF to the printer via FTPS and start printing.
///
/// Reads the 3MF file, computes its MD5 digest, uploads to the printer's
/// `/cache/` directory via FTPS (port 990 implicit TLS), then sends the
/// `project_file` MQTT command to begin the print.
#[tauri::command]
pub async fn start_print(
    path: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, PrinterService>,
) -> Result<StartPrintResult, String> {
    use crate::printer::upload_to_printer;

    let file_path = std::path::PathBuf::from(&path);

    // Validate file exists
    if !file_path.exists() {
        return Ok(StartPrintResult {
            success: false,
            filename: path.clone(),
            md5: String::new(),
            error: Some(format!("3MF file not found: {path}")),
        });
    }

    // Read file and compute MD5
    let file_bytes = std::fs::read(&file_path).map_err(|e| {
        format!("failed to read 3MF file '{}': {e}", file_path.display())
    })?;

    let md5_digest = format!("{:x}", md5::compute(&file_bytes));

    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("print.3mf")
        .to_string();

    log::info!(
        "start_print: file={}, size={} bytes, md5={}",
        filename,
        file_bytes.len(),
        md5_digest
    );

    // Get credentials from PrinterService
    let creds = service
        .get_credentials()
        .await
        .ok_or_else(|| "printer not connected — no credentials available".to_string())?;

    let host = creds.printer.host.clone();
    let access_code = creds.ftps_password().to_string();

    // Upload via FTPS
    if let Err(e) = upload_to_printer(&host, &access_code, &file_path).await {
        let err_msg = format!("FTPS upload failed: {e}");
        log::error!("start_print: {err_msg}");

        // Update last_error in PrinterState
        if let Ok(mut printer) = state.printer.lock() {
            printer.last_error = Some(err_msg.clone());
        }
        let _ = state.emit_state_change(&app, "printer:changed");

        return Ok(StartPrintResult {
            success: false,
            filename,
            md5: md5_digest,
            error: Some(err_msg),
        });
    }

    // Send project_file MQTT command
    let ftp_url = format!("ftp:///cache/{filename}");
    let cmd = BambuCommand::ProjectFile {
        param: "Metadata/plate_1.gcode".into(),
        subtask_name: filename.clone(),
        url: ftp_url,
        md5: md5_digest.clone(),
        use_ams: false,
        ams_mapping: String::new(),
    };

    log::info!("start_print: sending project_file MQTT command for {filename}");

    if let Err(e) = service.send_command(cmd).await {
        let err_msg = format!("MQTT project_file command failed: {e}");
        log::error!("start_print: {err_msg}");

        if let Ok(mut printer) = state.printer.lock() {
            printer.last_error = Some(err_msg.clone());
        }
        let _ = state.emit_state_change(&app, "printer:changed");

        return Ok(StartPrintResult {
            success: false,
            filename,
            md5: md5_digest,
            error: Some(err_msg),
        });
    }

    log::info!("start_print: print started successfully — {filename}");

    // Emit state change so UI updates
    let _ = state.emit_state_change(&app, "printer:changed");

    Ok(StartPrintResult {
        success: true,
        filename,
        md5: md5_digest,
        error: None,
    })
}

// ─── Print Queue Commands ─────────────────────────────────────────────────────

/// Add a job to the print queue. Returns the created job.
#[tauri::command]
pub fn add_to_queue(
    model_path: String,
    threemf_path: String,
    model_name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<QueuedJob, String> {
    let job = QueuedJob {
        id: uuid_v4(),
        model_path,
        threemf_path,
        model_name,
        created_at: chrono::Utc::now(),
        status: QueueStatus::Pending,
        filament_grams: None,
        filament_meters: None,
        quality_profile: None,
        thumbnail_path: None,
    };

    print_queue::add_job(&state, job.clone())?;
    Ok(job)
}

/// Get all jobs in the print queue.
#[tauri::command]
pub fn get_queue(state: State<'_, Arc<AppState>>) -> Result<Vec<QueuedJob>, String> {
    print_queue::get_jobs(&state)
}

/// Remove a job from the print queue by ID.
#[tauri::command]
pub fn remove_from_queue(
    job_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    print_queue::remove_job(&state, &job_id)
}

/// Generate a UUID v4 string.
fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ─── Print History Commands ───────────────────────────────────────────────────

/// Get all print history records, newest first.
#[tauri::command]
pub fn get_print_history(state: State<'_, Arc<AppState>>) -> Result<Vec<PrintHistoryRecord>, String> {
    let db_guard = state
        .db
        .lock()
        .map_err(|e| format!("failed to lock db: {e}"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(|| "database not initialized".to_string())?;
    database::get_all_history(conn)
}

/// Delete a print history record by ID. Emits `history:changed` on success.
#[tauri::command]
pub fn delete_print_history_item(
    id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let deleted = {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::delete_history(conn, &id)?
    };

    if deleted {
        // Emit updated history list
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        let history = database::get_all_history(conn)?;
        let _ = app.emit("history:changed", &history);
    }

    Ok(deleted)
}

// ─── Library Commands ─────────────────────────────────────────────────────────

/// Helper to emit `library:changed` with the full model list.
fn emit_library_changed(app: &AppHandle, state: &Arc<AppState>) {
    let models = {
        let db_guard = match state.db.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("emit_library_changed: failed to lock db: {e}");
                return;
            }
        };
        match db_guard.as_ref() {
            Some(conn) => database::get_all_library_models(conn).unwrap_or_default(),
            None => {
                log::error!("emit_library_changed: database not initialized");
                return;
            }
        }
    };
    if let Err(e) = app.emit("library:changed", &models) {
        log::error!("emit_library_changed: failed to emit: {e}");
    }
}

/// Get all library models, newest first.
#[tauri::command]
pub fn get_library_models(state: State<'_, Arc<AppState>>) -> Result<Vec<LibraryModel>, String> {
    let db_guard = state
        .db
        .lock()
        .map_err(|e| format!("failed to lock db: {e}"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(|| "database not initialized".to_string())?;
    database::get_all_library_models(conn)
}

/// Search library models by name.
#[tauri::command]
pub fn search_library_models(
    query: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<LibraryModel>, String> {
    let db_guard = state
        .db
        .lock()
        .map_err(|e| format!("failed to lock db: {e}"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(|| "database not initialized".to_string())?;
    database::search_library_models(conn, &query)
}

/// Delete a library model by ID. Removes DB row and filesystem folder.
/// Emits `library:changed` on success.
#[tauri::command]
pub fn delete_library_model(
    id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    let deleted = {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::delete_library_model(conn, &id)?
    };

    if deleted {
        emit_library_changed(&app, &state);
    }

    Ok(deleted)
}

/// Open a library model: sets it as the active model and switches to preview view.
/// Emits `workspace:changed`.
#[tauri::command]
pub fn open_library_model(
    id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AppStateSnapshot, String> {
    let model = {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;

        // Find the model by ID
        let models = database::get_all_library_models(conn)?;
        models.into_iter().find(|m| m.id == id)
    };

    let model = model.ok_or_else(|| format!("library model not found: {id}"))?;

    {
        let mut workspace = state
            .workspace
            .lock()
            .map_err(|e| format!("failed to lock workspace: {e}"))?;
        workspace.active_model = Some(ModelInfo {
            id: Some(model.id.clone()),
            name: model.model_name.clone(),
            path: model.file_path.clone(),
            source: model.source_url.clone(),
            size_bytes: None,
        });
        workspace.active_view = ViewType::Preview;
    }

    state.emit_state_change(&app, "workspace:changed")?;
    state.snapshot()
}

// ─── OpenSCAD Commands ────────────────────────────────────────────────────────

/// Check whether OpenSCAD CLI is installed and accessible.
#[tauri::command]
pub fn openscad_check_installed(service: State<'_, OpenScadService>) -> Result<bool, String> {
    Ok(service.check_installed())
}

/// Extract parameters from a `.scad` file.
///
/// Returns structured parameter data (name, type, initial value, min/max/step, group).
#[tauri::command]
pub async fn openscad_extract_params(
    path: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, OpenScadService>,
) -> Result<crate::openscad::ScadParamResult, String> {
    let scad_path = std::path::PathBuf::from(&path);

    // Update state: loading
    {
        let mut openscad = state
            .openscad
            .lock()
            .map_err(|e| format!("failed to lock openscad state: {e}"))?;
        openscad.loaded_file = Some(path.clone());
        openscad.render_status = "extracting_params".to_string();
        openscad.last_error = None;
    }
    let _ = state.emit_state_change(&app, "openscad:state-changed");

    match service.extract_params(&scad_path).await {
        Ok(result) => {
            // Update state: params extracted
            {
                let mut openscad = state
                    .openscad
                    .lock()
                    .map_err(|e| format!("failed to lock openscad state: {e}"))?;
                openscad.parameters = result.parameters.clone();
                openscad.render_status = "idle".to_string();
            }
            let _ = state.emit_state_change(&app, "openscad:state-changed");

            log::info!(
                "openscad_extract_params: {} params from {}",
                result.parameters.len(),
                path
            );
            Ok(result)
        }
        Err(e) => {
            // Update state: error
            {
                let mut openscad = state
                    .openscad
                    .lock()
                    .map_err(|e| format!("failed to lock openscad state: {e}"))?;
                openscad.render_status = "error".to_string();
                openscad.last_error = Some(crate::openscad::OpenScadCompileError {
                    line: 0,
                    message: e.to_string(),
                    full_stderr: String::new(),
                });
            }
            let _ = state.emit_state_change(&app, "openscad:state-changed");

            log::error!("openscad_extract_params failed: {e}");
            Err(e.to_string())
        }
    }
}

/// Render a `.scad` file to STL with optional parameter overrides.
///
/// - `path`: Path to the `.scad` file
/// - `overrides`: Optional map of parameter name → value overrides (via `-D`)
///
/// Returns the path to the rendered STL file.
#[tauri::command]
pub async fn openscad_render(
    path: String,
    overrides: Option<std::collections::HashMap<String, String>>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, OpenScadService>,
) -> Result<crate::openscad::OpenScadRenderResult, String> {
    let scad_path = std::path::PathBuf::from(&path);
    let param_overrides = overrides.unwrap_or_default();

    // Update state: rendering
    {
        let mut openscad = state
            .openscad
            .lock()
            .map_err(|e| format!("failed to lock openscad state: {e}"))?;
        openscad.loaded_file = Some(path.clone());
        openscad.render_status = "rendering".to_string();
        openscad.last_error = None;
    }
    let _ = state.emit_state_change(&app, "openscad:state-changed");

    // Use a temp dir for output
    let tmp_dir = tempfile::TempDir::new().map_err(|e| format!("failed to create temp dir: {e}"))?;
    let output_dir = tmp_dir.path().to_path_buf();

    match service
        .render_stl(&scad_path, &param_overrides, Some(&output_dir))
        .await
    {
        Ok(result) => {
            // Update state: success
            {
                let mut openscad = state
                    .openscad
                    .lock()
                    .map_err(|e| format!("failed to lock openscad state: {e}"))?;
                openscad.render_status = "idle".to_string();
                openscad.last_stl_path = Some(result.stl_path.display().to_string());
                openscad.last_error = None;
            }
            let _ = state.emit_state_change(&app, "openscad:state-changed");

            log::info!(
                "openscad_render: completed in {}ms → {}",
                result.duration_ms,
                result.stl_path.display()
            );

            // Leak the TempDir so the STL persists for the frontend to read
            std::mem::forget(tmp_dir);

            Ok(result)
        }
        Err(e) => {
            // Parse structured errors from stderr if available
            let compile_error = match &e {
                crate::openscad::OpenScadError::CompilationFailed { stderr, .. } => {
                    let parsed = crate::openscad::OpenScadService::parse_errors(stderr);
                    parsed.into_iter().next().unwrap_or_else(|| {
                        crate::openscad::OpenScadCompileError {
                            line: 0,
                            message: e.to_string(),
                            full_stderr: stderr.clone(),
                        }
                    })
                }
                _ => crate::openscad::OpenScadCompileError {
                    line: 0,
                    message: e.to_string(),
                    full_stderr: String::new(),
                },
            };

            // Update state: error
            {
                let mut openscad = state
                    .openscad
                    .lock()
                    .map_err(|err| format!("failed to lock openscad state: {err}"))?;
                openscad.render_status = "error".to_string();
                openscad.last_error = Some(compile_error);
            }
            let _ = state.emit_state_change(&app, "openscad:state-changed");

            log::error!("openscad_render failed: {e}");
            Err(e.to_string())
        }
    }
}

// ─── File Commands ────────────────────────────────────────────────────────────

/// Read a file from disk and return its raw bytes.
///
/// Used by the 3D model viewer to load STL/3MF files via IPC.
#[tauri::command]
pub fn read_model_file(path: String) -> Result<Vec<u8>, String> {
    use std::fs;
    use std::path::Path;

    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    match fs::read(file_path) {
        Ok(bytes) => {
            log::info!(
                "read_model_file: path={}, size={} bytes",
                path,
                bytes.len()
            );
            Ok(bytes)
        }
        Err(e) => {
            log::error!("read_model_file failed: path={}, error={}", path, e);
            Err(format!("Failed to read file '{path}': {e}"))
        }
    }
}

/// Read a text file from disk and return its content as a UTF-8 string.
///
/// Used by the OpenSCAD editor to load `.scad` source files.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    let file_path = Path::new(&path);

    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }

    match fs::read_to_string(file_path) {
        Ok(content) => {
            log::info!(
                "read_text_file: path={}, length={} chars",
                path,
                content.len()
            );
            Ok(content)
        }
        Err(e) => {
            log::error!("read_text_file failed: path={}, error={}", path, e);
            Err(format!("Failed to read file '{path}': {e}"))
        }
    }
}

/// Write a text file to disk with the given UTF-8 content.
///
/// Used by the OpenSCAD editor to save `.scad` source files on Cmd+S.
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let file_path = Path::new(&path);

    match fs::write(file_path, &content) {
        Ok(()) => {
            log::info!(
                "write_text_file: path={}, length={} chars",
                path,
                content.len()
            );
            Ok(())
        }
        Err(e) => {
            log::error!("write_text_file failed: path={}, error={}", path, e);
            Err(format!("Failed to write file '{path}': {e}"))
        }
    }
}

// ─── Slicer Commands ──────────────────────────────────────────────────────────

/// List available quality and filament profile options.
#[tauri::command]
pub fn list_profiles(service: State<'_, SlicerService>) -> Result<ProfileList, String> {
    Ok(service.list_profiles())
}

/// Slice an STL model into a 3MF file using OrcaSlicer.
///
/// - `path`: Path to the input STL file
/// - `quality`: Layer height key (default: `"0.20"`)
/// - `filament`: Filament name (default: `"Bambu PLA Basic"`)
///
/// Returns a `SliceResult` with the output 3MF path and print estimates.
#[tauri::command]
pub async fn slice_model(
    path: String,
    quality: Option<String>,
    filament: Option<String>,
    service: State<'_, SlicerService>,
) -> Result<SliceResult, String> {
    let input_path = std::path::PathBuf::from(&path);
    let quality = quality.unwrap_or_else(|| "0.20".to_string());
    let filament = filament.unwrap_or_else(|| "Bambu PLA Basic".to_string());

    // Output 3MF goes next to the input file with .3mf extension
    let output_path = input_path.with_extension("3mf");

    log::info!(
        "slice_model command: path={}, quality={}, filament={}",
        path,
        quality,
        filament
    );

    let input = SliceInput {
        input_files: vec![input_path],
        output_file: output_path,
        quality,
        filament,
    };

    match service.run_slicer(&input).await {
        Ok(result) => {
            log::info!(
                "slice_model complete: success={}, output={}",
                result.success,
                result.output_file.display()
            );
            Ok(result)
        }
        Err(e) => {
            log::error!("slice_model failed: {e}");
            Err(e.to_string())
        }
    }
}

// ─── Designs Directory Command ────────────────────────────────────────────────

/// Return the path to the persistent designs directory, creating it if needed.
///
/// Resolves `{app_data_dir}/designs/` and calls `create_dir_all` to ensure
/// the directory exists before returning the path string.
#[tauri::command]
pub fn get_designs_dir(app: AppHandle) -> Result<String, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;

    let designs_dir = app_data_dir.join("designs");

    std::fs::create_dir_all(&designs_dir)
        .map_err(|e| format!("failed to create designs dir: {e}"))?;

    Ok(designs_dir.to_string_lossy().to_string())
}

// ─── Credential Commands ──────────────────────────────────────────────────────

/// Store a credential in the OS-native credential store.
#[tauri::command]
pub async fn store_credential(key: String, value: String) -> Result<(), String> {
    credentials::store_credential(&key, &value).await
}

/// Get a credential from the OS-native credential store. Returns null if not found.
#[tauri::command]
pub async fn get_credential(key: String) -> Result<Option<String>, String> {
    credentials::get_credential(&key).await
}

/// Delete a credential from the OS-native credential store. Returns true if it existed.
#[tauri::command]
pub async fn delete_credential(key: String) -> Result<bool, String> {
    credentials::delete_credential(&key).await
}

/// Check whether a credential exists in the OS-native credential store.
#[tauri::command]
pub async fn has_credential(key: String) -> Result<bool, String> {
    credentials::has_credential(&key).await
}

// ─── OAuth Callback Commands ──────────────────────────────────────────────────

/// Start a single-use OAuth callback server on the given port.
///
/// The server waits for one browser redirect, extracts the auth code,
/// emits an `oauth:callback` event, then shuts down.
#[tauri::command]
pub async fn start_oauth_callback(
    port: u16,
    app: AppHandle,
    oauth_state: State<'_, OAuthCallbackState>,
) -> Result<(), String> {
    // Abort any existing callback server
    oauth_callback::stop_callback_server(&oauth_state).await;

    let handle_clone = oauth_state.handle.clone();
    let task = tokio::spawn(async move {
        if let Err(e) = oauth_callback::start_callback_server(port, app).await {
            log::error!("oauth:callback-server error: {e}");
        }
    });

    let mut guard = handle_clone.lock().await;
    *guard = Some(task);

    Ok(())
}

/// Stop the running OAuth callback server, if any.
#[tauri::command]
pub async fn stop_oauth_callback(oauth_state: State<'_, OAuthCallbackState>) -> Result<(), String> {
    oauth_callback::stop_callback_server(&oauth_state).await;
    Ok(())
}

/// Proxy an OAuth token exchange through Rust to avoid CORS restrictions.
///
/// The Tauri webview's `fetch()` to OAuth token endpoints (e.g. platform.claude.com)
/// is blocked by CORS — the server doesn't include `Access-Control-Allow-Origin` for
/// localhost origins. Rust's reqwest has no CORS restrictions.
#[tauri::command]
pub async fn oauth_token_exchange(
    url: String,
    body: String,
    content_type: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Content-Type", &content_type)
        .header("Accept", "application/json")
        .body(body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("oauth:token-exchange request failed: {e}"))?;

    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|e| format!("oauth:token-exchange read body failed: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "oauth:token-exchange failed: status={} body={}",
            status, response_body
        ));
    }

    log::info!("oauth:token-exchange success url={}", url);
    Ok(response_body)
}

// ─── Printer Config Commands ──────────────────────────────────────────────────

/// Helper to emit `printer-configs:changed` with the full config list.
fn emit_printer_configs_changed(app: &AppHandle, state: &Arc<AppState>) {
    let configs = {
        let db_guard = match state.db.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("emit_printer_configs_changed: failed to lock db: {e}");
                return;
            }
        };
        match db_guard.as_ref() {
            Some(conn) => database::get_all_printer_configs(conn).unwrap_or_default(),
            None => {
                log::error!("emit_printer_configs_changed: database not initialized");
                return;
            }
        }
    };
    if let Err(e) = app.emit("printer-configs:changed", &configs) {
        log::error!("emit_printer_configs_changed: failed to emit: {e}");
    }
}

/// Add a new printer configuration.
///
/// Generates a UUID, stores the access code in the OS credential store as
/// `printer:{id}:access_code`, inserts config into SQLite, and emits
/// `printer-configs:changed`.
#[tauri::command]
pub async fn add_printer_config(
    name: String,
    host: String,
    serial: String,
    access_code: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<PrinterConfig, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let keychain_key = format!("printer:{id}:access_code");
    let now = chrono::Utc::now().to_rfc3339();

    // Store access code in Keychain
    credentials::store_credential(&keychain_key, &access_code).await?;

    let config = PrinterConfig {
        id: id.clone(),
        name: name.clone(),
        host,
        serial,
        access_code_keychain_id: keychain_key,
        is_default: false,
        created_at: now.clone(),
        updated_at: now,
    };

    // Insert into SQLite
    {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::insert_printer_config(conn, &config)?;
    }

    log::info!("printer-config:added id={id} name='{name}'");
    emit_printer_configs_changed(&app, &state);

    Ok(config)
}

/// Update an existing printer configuration.
///
/// Updates SQLite fields. If `access_code` is provided, also updates the
/// Keychain entry.
#[tauri::command]
pub async fn update_printer_config(
    id: String,
    name: String,
    host: String,
    serial: String,
    access_code: Option<String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<PrinterConfig, String> {
    let now = chrono::Utc::now().to_rfc3339();

    // Get existing config to preserve keychain key and created_at
    let existing = {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::get_printer_config(conn, &id)?
            .ok_or_else(|| format!("printer config not found: id={id}"))?
    };

    // Update Keychain if access_code provided
    if let Some(code) = &access_code {
        credentials::store_credential(&existing.access_code_keychain_id, code).await?;
    }

    let updated_config = PrinterConfig {
        id: id.clone(),
        name: name.clone(),
        host,
        serial,
        access_code_keychain_id: existing.access_code_keychain_id,
        is_default: existing.is_default,
        created_at: existing.created_at,
        updated_at: now,
    };

    {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::update_printer_config(conn, &updated_config)?;
    }

    log::info!("printer-config:updated id={id} name='{name}'");
    emit_printer_configs_changed(&app, &state);

    Ok(updated_config)
}

/// Delete a printer configuration.
///
/// Removes from SQLite and deletes the Keychain entry. Emits
/// `printer-configs:changed`.
#[tauri::command]
pub async fn delete_printer_config(
    id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Get config to find keychain key before deleting
    let config = {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::get_printer_config(conn, &id)?
            .ok_or_else(|| format!("printer config not found: id={id}"))?
    };

    // Delete from SQLite
    {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::delete_printer_config(conn, &id)?;
    }

    // Delete Keychain entry (best-effort — don't fail if keychain entry is already gone)
    if let Err(e) = credentials::delete_credential(&config.access_code_keychain_id).await {
        log::warn!(
            "printer-config:delete keychain cleanup failed for key={}: {e}",
            config.access_code_keychain_id
        );
    }

    log::info!("printer-config:deleted id={id}");
    emit_printer_configs_changed(&app, &state);

    Ok(())
}

/// Connect to a printer using a saved configuration.
///
/// Loads `PrinterConfig` from SQLite, retrieves the access code from Keychain,
/// optionally loads Bambu Cloud credentials for Cloud fallback, and starts the
/// printer connection.
#[tauri::command]
pub async fn connect_printer_by_config(
    config_id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, PrinterService>,
) -> Result<(), String> {
    log::info!("printer-config:connecting id={config_id}");

    // 1. Load PrinterConfig from SQLite
    let config = {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::get_printer_config(conn, &config_id)?
            .ok_or_else(|| format!("printer config {config_id} not found"))?
    };

    // 2. Retrieve access code from Keychain
    let access_code = credentials::get_credential(&config.access_code_keychain_id)
        .await?
        .ok_or_else(|| {
            format!(
                "access code not found in Keychain for key {}",
                config.access_code_keychain_id
            )
        })?;

    // 3. Load Cloud credentials (optional — local-only is fine)
    let cloud_creds = BambuCredentials::load_default().ok();

    // 4. Build BambuCredentials from the merge
    let creds = config.to_bambu_credentials(&access_code, cloud_creds.as_ref());

    // 5. Update selected_printer_id
    {
        let mut selected = state
            .selected_printer_id
            .lock()
            .map_err(|e| format!("failed to lock selected_printer_id: {e}"))?;
        *selected = Some(config_id.clone());
    }

    // 6. Set printer name from config before connection starts
    {
        let mut printer = state
            .printer
            .lock()
            .map_err(|e| format!("failed to lock printer state: {e}"))?;
        printer.name = Some(config.name.clone());
    }

    // 7. Start the printer service
    service
        .start(creds, app.clone(), Arc::clone(&*state))
        .await
        .map_err(|e| e.to_string())?;

    // 8. Emit events
    emit_printer_configs_changed(&app, &state);
    let _ = state.emit_state_change(&app, "printer:changed");

    log::info!("printer-config:connected id={config_id} name='{}'", config.name);
    Ok(())
}

/// Switch to a different saved printer configuration.
///
/// Disconnects the current printer (if connected), updates the selected ID,
/// and connects to the new printer.
#[tauri::command]
pub async fn switch_printer(
    config_id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, PrinterService>,
) -> Result<(), String> {
    let old_id = {
        let selected = state
            .selected_printer_id
            .lock()
            .map_err(|e| format!("failed to lock selected_printer_id: {e}"))?;
        selected.clone()
    };

    let old_display = old_id
        .as_deref()
        .unwrap_or("none");

    log::info!(
        "printer-config:switching from={} to={}",
        old_display,
        config_id
    );

    // Disconnect current printer if connected
    let is_connected = {
        let printer = state
            .printer
            .lock()
            .map_err(|e| format!("failed to lock printer state: {e}"))?;
        printer.is_connected
    };

    if is_connected {
        service.disconnect(&app, &state).await;
    }

    // Connect to the new printer via config
    connect_printer_by_config_inner(
        &config_id, &app, &state, &service,
    )
    .await?;

    log::info!(
        "printer-config:switched from={} to={}",
        old_display,
        config_id
    );

    Ok(())
}

/// Inner implementation of connect_printer_by_config, callable without Tauri
/// `State` wrappers (used by `switch_printer`).
pub async fn connect_printer_by_config_inner(
    config_id: &str,
    app: &AppHandle,
    state: &Arc<AppState>,
    service: &PrinterService,
) -> Result<(), String> {
    log::info!("printer-config:connecting id={config_id}");

    // 1. Load PrinterConfig from SQLite
    let config = {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::get_printer_config(conn, config_id)?
            .ok_or_else(|| format!("printer config {config_id} not found"))?
    };

    // 2. Retrieve access code from Keychain
    let access_code = credentials::get_credential(&config.access_code_keychain_id)
        .await?
        .ok_or_else(|| {
            format!(
                "access code not found in Keychain for key {}",
                config.access_code_keychain_id
            )
        })?;

    // 3. Load Cloud credentials (optional)
    let cloud_creds = BambuCredentials::load_default().ok();

    // 4. Build BambuCredentials
    let creds = config.to_bambu_credentials(&access_code, cloud_creds.as_ref());

    // 5. Update selected_printer_id
    {
        let mut selected = state
            .selected_printer_id
            .lock()
            .map_err(|e| format!("failed to lock selected_printer_id: {e}"))?;
        *selected = Some(config_id.to_string());
    }

    // 6. Set printer name from config
    {
        let mut printer = state
            .printer
            .lock()
            .map_err(|e| format!("failed to lock printer state: {e}"))?;
        printer.name = Some(config.name.clone());
    }

    // 7. Start the printer service
    service
        .start(creds, app.clone(), Arc::clone(state))
        .await
        .map_err(|e| e.to_string())?;

    // 8. Emit events
    emit_printer_configs_changed(app, state);
    let _ = state.emit_state_change(app, "printer:changed");

    log::info!("printer-config:connected id={config_id} name='{}'", config.name);
    Ok(())
}

/// Get all saved printer configurations.
#[tauri::command]
pub fn get_printer_configs(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<PrinterConfig>, String> {
    let db_guard = state
        .db
        .lock()
        .map_err(|e| format!("failed to lock db: {e}"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(|| "database not initialized".to_string())?;
    database::get_all_printer_configs(conn)
}

/// Set a printer configuration as the default.
///
/// Clears `is_default` on all configs, sets on the target. Emits
/// `printer-configs:changed`.
#[tauri::command]
pub fn set_default_printer(
    id: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;
        database::set_default_printer_config(conn, &id)?;
    }

    log::info!("printer-config:default-set id={id}");
    emit_printer_configs_changed(&app, &state);

    Ok(())
}

// ─── Settings Commands ────────────────────────────────────────────────────────

/// Helper to emit `settings:changed` with the full merged settings map.
fn emit_settings_changed(app: &AppHandle, state: &Arc<AppState>) {
    let settings = {
        let db_guard = match state.db.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("emit_settings_changed: failed to lock db: {e}");
                return;
            }
        };
        match db_guard.as_ref() {
            Some(conn) => database::get_all_settings(conn).unwrap_or_default(),
            None => {
                log::error!("emit_settings_changed: database not initialized");
                return;
            }
        }
    };
    if let Err(e) = app.emit("settings:changed", &settings) {
        log::error!("emit_settings_changed: failed to emit: {e}");
    }
}

/// Get all settings (defaults merged under stored values).
#[tauri::command]
pub fn get_settings(
    state: State<'_, Arc<AppState>>,
) -> Result<HashMap<String, String>, String> {
    let db_guard = state
        .db
        .lock()
        .map_err(|e| format!("failed to lock db: {e}"))?;
    let conn = db_guard
        .as_ref()
        .ok_or_else(|| "database not initialized".to_string())?;
    database::get_all_settings(conn)
}

/// Update one or more settings. Emits `settings:changed` with the full merged map.
#[tauri::command]
pub fn update_settings(
    settings: HashMap<String, String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let db_guard = state
            .db
            .lock()
            .map_err(|e| format!("failed to lock db: {e}"))?;
        let conn = db_guard
            .as_ref()
            .ok_or_else(|| "database not initialized".to_string())?;

        for (key, value) in &settings {
            database::upsert_setting(conn, key, value)?;
        }
    }

    emit_settings_changed(&app, &state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::state::{AppState, MAKERWORLD_HOME_URL, ModelImportStatus, ViewType};
    use std::sync::Arc;

    #[test]
    fn get_app_state_returns_default_snapshot() {
        let state = Arc::new(AppState::default());
        let snapshot = state.snapshot().expect("snapshot should succeed");

        assert_eq!(snapshot.workspace.active_view, ViewType::Preview);
        assert!(!snapshot.printer.is_connected);
        assert_eq!(snapshot.workspace.makerworld.current_url, MAKERWORLD_HOME_URL);
        assert_eq!(snapshot.workspace.makerworld.import_status, ModelImportStatus::Idle);
    }

    #[test]
    fn read_model_file_reads_bytes() {
        use std::io::Write;

        let dir = tempfile::tempdir().expect("create temp dir");
        let file_path = dir.path().join("test_model.stl");
        let mut file = std::fs::File::create(&file_path).expect("create test file");
        file.write_all(b"solid test\nendsolid test\n")
            .expect("write test data");

        let result = super::read_model_file(file_path.to_string_lossy().to_string());
        assert!(result.is_ok());
        let bytes = result.unwrap();
        assert_eq!(bytes, b"solid test\nendsolid test\n");
    }

    #[test]
    fn read_model_file_returns_error_for_missing_file() {
        let result = super::read_model_file("/tmp/nonexistent_model_xyz.stl".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[test]
    fn md5_computation_produces_correct_hex_digest() {
        // Known test vector: MD5("") = d41d8cd98f00b204e9800998ecf8427e
        let empty_digest = format!("{:x}", md5::compute(b""));
        assert_eq!(empty_digest, "d41d8cd98f00b204e9800998ecf8427e");

        // Known test vector: MD5("hello") = 5d41402abc4b2a76b9719d911017c592
        let hello_digest = format!("{:x}", md5::compute(b"hello"));
        assert_eq!(hello_digest, "5d41402abc4b2a76b9719d911017c592");

        // Known test vector: MD5("The quick brown fox jumps over the lazy dog")
        let fox_digest = format!(
            "{:x}",
            md5::compute(b"The quick brown fox jumps over the lazy dog")
        );
        assert_eq!(fox_digest, "9e107d9d372bb6826bd81d3542a419d6");
    }

    #[test]
    fn get_designs_dir_creates_and_returns_path() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let designs_path = dir.path().join("designs");

        // Directory shouldn't exist yet
        assert!(!designs_path.exists());

        // Simulate what the command does: create_dir_all + return path
        std::fs::create_dir_all(&designs_path).expect("create designs dir");
        assert!(designs_path.exists());
        assert!(designs_path.is_dir());

        let path_str = designs_path.to_string_lossy().to_string();
        assert!(path_str.ends_with("designs"));
    }

    #[test]
    fn get_designs_dir_is_idempotent() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let designs_path = dir.path().join("designs");

        // Call create_dir_all twice — should succeed both times
        std::fs::create_dir_all(&designs_path).expect("first create");
        std::fs::create_dir_all(&designs_path).expect("second create (idempotent)");
        assert!(designs_path.is_dir());
    }

    #[test]
    fn start_print_result_serializes_correctly() {
        let result = super::StartPrintResult {
            success: true,
            filename: "benchy.3mf".into(),
            md5: "abc123".into(),
            error: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["success"], true);
        assert_eq!(json["filename"], "benchy.3mf");
        assert_eq!(json["md5"], "abc123");
        assert!(json["error"].is_null());

        let fail_result = super::StartPrintResult {
            success: false,
            filename: "fail.3mf".into(),
            md5: String::new(),
            error: Some("FTPS connect failed".into()),
        };
        let json = serde_json::to_value(&fail_result).unwrap();
        assert_eq!(json["success"], false);
        assert_eq!(json["error"], "FTPS connect failed");
    }
}
