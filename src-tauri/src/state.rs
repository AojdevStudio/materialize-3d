use std::sync::Mutex;

use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::openscad::{OpenScadCompileError, ScadParameter};

// ─── Printer Config Types ─────────────────────────────────────────────────────

/// A saved printer configuration stored in SQLite.
///
/// Access codes are stored in the OS-native credential store — the database only stores a
/// Keychain key reference (`access_code_keychain_id`).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub serial: String,
    pub access_code_keychain_id: String,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl PrinterConfig {
    /// Build `BambuCredentials` from this config and an access code.
    ///
    /// For local-only MQTT connections (the primary path), `cloud_creds` can
    /// be `None`. If present, `access_token` and `user_id` are pulled from the
    /// Cloud credentials for Cloud fallback support.
    pub fn to_bambu_credentials(
        &self,
        access_code: &str,
        cloud_creds: Option<&crate::printer::BambuCredentials>,
    ) -> crate::printer::BambuCredentials {
        use crate::printer::credentials::PrinterInfo;

        let (access_token, user_id, user_name, expires_at, created_at) = match cloud_creds {
            Some(cc) => (
                cc.access_token.clone(),
                cc.user_id.clone(),
                cc.user_name.clone(),
                cc.expires_at,
                cc.created_at,
            ),
            None => (
                String::new(),
                String::new(),
                None,
                None,
                None,
            ),
        };

        crate::printer::BambuCredentials {
            access_token,
            user_id,
            user_name,
            printer: PrinterInfo {
                name: self.name.clone(),
                device_id: self.serial.clone(),
                model: String::new(), // not stored in config
                access_code: access_code.to_string(),
                host: self.host.clone(),
            },
            expires_at,
            created_at,
        }
    }
}

// ─── Print History Types ──────────────────────────────────────────────────────

/// A completed or failed print job recorded in SQLite.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrintHistoryRecord {
    pub id: String,
    pub model_name: String,
    pub gcode_file: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: String,
    pub duration_seconds: Option<i64>,
    pub status: String,
    pub fail_reason: Option<String>,
    pub filament_grams: Option<f64>,
    pub filament_meters: Option<f64>,
    pub thumbnail_path: Option<String>,
    pub quality_profile: Option<String>,
}

pub const MAKERWORLD_HOME_URL: &str = "https://makerworld.com/en";

// ─── Library Model Types ──────────────────────────────────────────────────────

/// A model stored in the local library, indexed from filesystem metadata.json.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryModel {
    pub id: String,
    pub model_name: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    pub imported_at: String,
    #[serde(default)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    pub file_path: Option<String>,
    pub folder_path: String,
    #[serde(default)]
    pub rating: Option<f32>,
    #[serde(default)]
    pub download_count: Option<u32>,
    #[serde(default)]
    pub file_count: Option<u32>,
}

// ─── Print Queue Types ────────────────────────────────────────────────────────

/// Status of a queued print job.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum QueueStatus {
    Pending,
    Submitted,
    Failed { reason: String },
}

impl Default for QueueStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// A job waiting in the print queue.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedJob {
    pub id: String,
    pub model_path: String,
    pub threemf_path: String,
    pub model_name: String,
    pub created_at: DateTime<Utc>,
    #[serde(flatten)]
    pub status: QueueStatus,
    #[serde(default)]
    pub filament_grams: Option<f64>,
    #[serde(default)]
    pub filament_meters: Option<f64>,
    #[serde(default)]
    pub quality_profile: Option<String>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionType {
    #[default]
    Mqtt,
    Cloud,
}

/// State machine for printer connectivity.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    #[default]
    Disconnected,
    Discovering,
    ConnectedMqtt,
    ConnectedCloud,
    Reconnecting,
    Offline,
}

/// AMS tray (single filament slot) state.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AmsTrayState {
    #[serde(default)]
    pub tray_id: Option<u8>,
    #[serde(default)]
    pub tray_type: Option<String>,
    #[serde(default)]
    pub tray_color: Option<String>,
}

/// AMS unit state.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AmsUnitState {
    #[serde(default)]
    pub id: Option<u8>,
    #[serde(default)]
    pub trays: Vec<AmsTrayState>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ViewType {
    #[default]
    Preview,
    Browser,
    Scad,
    Monitor,
    Queue,
    History,
    Library,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: Option<String>,
    pub name: String,
    pub path: Option<String>,
    pub source: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MakerWorldPageKind {
    #[default]
    Home,
    Search,
    Model,
    Other,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelImportStatus {
    #[default]
    Idle,
    Ready,
    Downloading,
    Imported,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MakerWorldFile {
    pub name: String,
    #[serde(default)]
    pub file_type: Option<String>,
    #[serde(default)]
    pub download_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MakerWorldModel {
    #[serde(default)]
    pub id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    pub source_url: String,
    #[serde(default)]
    pub rating: Option<f32>,
    #[serde(default)]
    pub review_count: Option<u32>,
    #[serde(default)]
    pub download_count: Option<u32>,
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub files: Vec<MakerWorldFile>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MakerWorldBrowserState {
    pub current_url: String,
    pub page_kind: MakerWorldPageKind,
    #[serde(default)]
    pub detected_model: Option<MakerWorldModel>,
    pub import_status: ModelImportStatus,
    #[serde(default)]
    pub imported_files: Vec<String>,
    #[serde(default)]
    pub last_extraction_error: Option<String>,
}

impl Default for MakerWorldBrowserState {
    fn default() -> Self {
        Self {
            current_url: MAKERWORLD_HOME_URL.into(),
            page_kind: MakerWorldPageKind::Home,
            detected_model: None,
            import_status: ModelImportStatus::Idle,
            imported_files: Vec::new(),
            last_extraction_error: None,
        }
    }
}

/// Status of the printer's IP camera.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CameraStatus {
    #[default]
    Unavailable,
    Probing,
    Available,
    Error,
}

/// Camera state combining status, snapshot URL, and diagnostic info.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CameraState {
    pub status: CameraStatus,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterState {
    pub is_connected: bool,
    #[serde(default)]
    pub connection_type: Option<ConnectionType>,
    #[serde(default)]
    pub connection_state: ConnectionState,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub nozzle_temp: Option<f32>,
    #[serde(default)]
    pub nozzle_target_temp: Option<f32>,
    #[serde(default)]
    pub bed_temp: Option<f32>,
    #[serde(default)]
    pub bed_target_temp: Option<f32>,
    #[serde(default)]
    pub chamber_temp: Option<f32>,
    #[serde(default)]
    pub gcode_state: Option<String>,
    #[serde(default)]
    pub print_progress: Option<u8>,
    #[serde(default)]
    pub remaining_time: Option<u32>,
    #[serde(default)]
    pub layer_num: Option<u32>,
    #[serde(default)]
    pub total_layer_num: Option<u32>,
    #[serde(default)]
    pub subtask_name: Option<String>,
    #[serde(default)]
    pub wifi_signal: Option<String>,
    #[serde(default)]
    pub ams_state: Vec<AmsUnitState>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub camera_state: CameraState,
    /// Printer LAN IP — set when connection is established.
    /// Used to construct camera snapshot URLs.
    #[serde(default)]
    pub printer_ip: Option<String>,
    /// Gcode start time reported by the printer (MQTT `gcode_start_time`).
    #[serde(default)]
    pub gcode_start_time: Option<String>,
    /// Current gcode file name from MQTT `gcode_file`.
    #[serde(default)]
    pub gcode_file: Option<String>,
    /// Reason for print failure from MQTT `fail_reason`.
    #[serde(default)]
    pub fail_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub active_model: Option<ModelInfo>,
    pub active_view: ViewType,
    #[serde(default)]
    pub makerworld: MakerWorldBrowserState,
}

/// Snapshot of the OpenSCAD design tab state.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenScadSnapshot {
    #[serde(default)]
    pub loaded_file: Option<String>,
    #[serde(default)]
    pub parameters: Vec<ScadParameter>,
    #[serde(default)]
    pub render_status: String,
    #[serde(default)]
    pub last_stl_path: Option<String>,
    #[serde(default)]
    pub last_error: Option<OpenScadCompileError>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    pub printer: PrinterState,
    pub workspace: WorkspaceState,
    pub print_queue: Vec<QueuedJob>,
    #[serde(default)]
    pub openscad: OpenScadSnapshot,
    #[serde(default)]
    pub selected_printer_id: Option<String>,
}

#[derive(Debug, Default)]
pub struct AppState {
    pub printer: Mutex<PrinterState>,
    pub workspace: Mutex<WorkspaceState>,
    pub print_queue: Mutex<Vec<QueuedJob>>,
    pub openscad: Mutex<OpenScadSnapshot>,
    pub db: Mutex<Option<Connection>>,
    /// Deduplication guard: the `gcode_start_time` of the last recorded history entry.
    /// Prevents duplicate history records from repeated pushall/push_status messages.
    pub last_recorded_start_time: Mutex<Option<String>>,
    /// Currently selected printer config ID (for multi-printer support).
    pub selected_printer_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn snapshot(&self) -> Result<AppStateSnapshot, String> {
        let printer = self
            .printer
            .lock()
            .map_err(|error| format!("failed to lock printer state: {error}"))?
            .clone();
        let workspace = self
            .workspace
            .lock()
            .map_err(|error| format!("failed to lock workspace state: {error}"))?
            .clone();
        let print_queue = self
            .print_queue
            .lock()
            .map_err(|error| format!("failed to lock print queue: {error}"))?
            .clone();
        let openscad = self
            .openscad
            .lock()
            .map_err(|error| format!("failed to lock openscad state: {error}"))?
            .clone();
        let selected_printer_id = self
            .selected_printer_id
            .lock()
            .map_err(|error| format!("failed to lock selected_printer_id: {error}"))?
            .clone();

        Ok(AppStateSnapshot {
            printer,
            workspace,
            print_queue,
            openscad,
            selected_printer_id,
        })
    }

    pub fn emit_state_change<R: tauri::Runtime>(
        &self,
        handle: &AppHandle<R>,
        event_name: &str,
    ) -> Result<(), String> {
        let payload = match event_name {
            "workspace:changed" => serde_json::to_value(
                self.workspace
                    .lock()
                    .map_err(|error| format!("failed to lock workspace state: {error}"))?
                    .clone(),
            )
            .map_err(|error| format!("failed to serialize workspace state: {error}"))?,
            "printer:changed" => serde_json::to_value(
                self.printer
                    .lock()
                    .map_err(|error| format!("failed to lock printer state: {error}"))?
                    .clone(),
            )
            .map_err(|error| format!("failed to serialize printer state: {error}"))?,
            "openscad:state-changed" => serde_json::to_value(
                self.openscad
                    .lock()
                    .map_err(|error| format!("failed to lock openscad state: {error}"))?
                    .clone(),
            )
            .map_err(|error| format!("failed to serialize openscad state: {error}"))?,
            _ => serde_json::to_value(self.snapshot()?)
                .map_err(|error| format!("failed to serialize app state snapshot: {error}"))?,
        };

        log::info!("emitting state event: {event_name}");
        handle
            .emit(event_name, payload)
            .map_err(|error| format!("failed to emit {event_name}: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AppState, CameraState, CameraStatus, ConnectionState, MakerWorldPageKind,
        MAKERWORLD_HOME_URL, ModelImportStatus, PrinterState, QueueStatus, QueuedJob, ViewType,
    };

    #[test]
    fn app_state_defaults_to_preview_workspace() {
        let state = AppState::default();
        let snapshot = state.snapshot().expect("snapshot should succeed");

        assert_eq!(snapshot.workspace.active_view, ViewType::Preview);
        assert!(!snapshot.printer.is_connected);
        assert_eq!(snapshot.workspace.makerworld.current_url, MAKERWORLD_HOME_URL);
        assert_eq!(snapshot.workspace.makerworld.page_kind, MakerWorldPageKind::Home);
        assert_eq!(snapshot.workspace.makerworld.import_status, ModelImportStatus::Idle);
        assert!(snapshot.print_queue.is_empty());
    }

    #[test]
    fn connection_state_serde_round_trip() {
        use super::ConnectionState;

        let states = vec![
            ConnectionState::Disconnected,
            ConnectionState::Discovering,
            ConnectionState::ConnectedMqtt,
            ConnectionState::ConnectedCloud,
            ConnectionState::Reconnecting,
            ConnectionState::Offline,
        ];

        for state in states {
            let json = serde_json::to_string(&state).expect("serialize");
            let back: ConnectionState = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(state, back);
        }
    }

    #[test]
    fn printer_state_extended_fields_default() {
        let state = PrinterState::default();
        assert_eq!(state.connection_state, ConnectionState::Disconnected);
        assert!(state.chamber_temp.is_none());
        assert!(state.gcode_state.is_none());
        assert!(state.print_progress.is_none());
        assert!(state.ams_state.is_empty());
        assert!(state.last_error.is_none());
        assert!(state.nozzle_target_temp.is_none());
        assert!(state.bed_target_temp.is_none());
        assert!(state.remaining_time.is_none());
        assert!(state.layer_num.is_none());
        assert!(state.total_layer_num.is_none());
        assert!(state.subtask_name.is_none());
        assert!(state.wifi_signal.is_none());
        assert_eq!(state.camera_state.status, CameraStatus::Unavailable);
        assert!(state.camera_state.url.is_none());
        assert!(state.camera_state.diagnostic.is_none());
        assert!(state.printer_ip.is_none());
        assert!(state.gcode_start_time.is_none());
        assert!(state.gcode_file.is_none());
        assert!(state.fail_reason.is_none());
    }

    #[test]
    fn camera_state_serde_round_trip() {
        let camera = CameraState {
            status: CameraStatus::Available,
            url: Some("http://192.0.2.136:6000/".into()),
            diagnostic: None,
        };
        let json = serde_json::to_string(&camera).expect("serialize");
        let back: CameraState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(camera, back);

        // All statuses round-trip
        for status in [
            CameraStatus::Unavailable,
            CameraStatus::Probing,
            CameraStatus::Available,
            CameraStatus::Error,
        ] {
            let json = serde_json::to_string(&status).expect("serialize");
            let back: CameraStatus = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(status, back);
        }
    }

    #[test]
    fn makerworld_page_kind_serde_round_trip() {
        let json = serde_json::to_string(&MakerWorldPageKind::Model).expect("serialize");
        let back: MakerWorldPageKind = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, MakerWorldPageKind::Model);
    }

    #[test]
    fn queue_status_serde_round_trip() {
        let statuses = vec![
            QueueStatus::Pending,
            QueueStatus::Submitted,
            QueueStatus::Failed {
                reason: "FTPS timeout".into(),
            },
        ];

        for status in statuses {
            let json = serde_json::to_string(&status).expect("serialize");
            let back: QueueStatus = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(status, back);
        }
    }

    #[test]
    fn queued_job_serde_round_trip() {
        let job = QueuedJob {
            id: "test-123".into(),
            model_path: "/tmp/model.stl".into(),
            threemf_path: "/tmp/model.3mf".into(),
            model_name: "Benchy".into(),
            created_at: chrono::Utc::now(),
            status: QueueStatus::Pending,
            filament_grams: Some(12.5),
            filament_meters: Some(4.2),
            quality_profile: Some("0.20mm".into()),
            thumbnail_path: None,
        };

        let json = serde_json::to_string(&job).expect("serialize");
        let back: QueuedJob = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(job.id, back.id);
        assert_eq!(job.model_name, back.model_name);
        assert_eq!(job.status, back.status);
        assert_eq!(back.filament_grams, Some(12.5));
        assert_eq!(back.filament_meters, Some(4.2));
        assert_eq!(back.quality_profile.as_deref(), Some("0.20mm"));
        assert!(back.thumbnail_path.is_none());
    }

    #[test]
    fn snapshot_includes_print_queue() {
        let state = AppState::default();
        let job = QueuedJob {
            id: "q1".into(),
            model_path: "/tmp/model.stl".into(),
            threemf_path: "/tmp/model.3mf".into(),
            model_name: "Hook".into(),
            created_at: chrono::Utc::now(),
            status: QueueStatus::Pending,
            filament_grams: None,
            filament_meters: None,
            quality_profile: None,
            thumbnail_path: None,
        };
        state.print_queue.lock().unwrap().push(job.clone());

        let snapshot = state.snapshot().expect("snapshot should succeed");
        assert_eq!(snapshot.print_queue.len(), 1);
        assert_eq!(snapshot.print_queue[0].id, "q1");
    }

    #[test]
    fn print_history_record_serde_round_trip() {
        use super::PrintHistoryRecord;

        let record = PrintHistoryRecord {
            id: "ph-1".into(),
            model_name: "Benchy".into(),
            gcode_file: Some("plate_1.gcode".into()),
            started_at: Some("2026-03-15T10:00:00Z".into()),
            completed_at: "2026-03-15T11:00:00Z".into(),
            duration_seconds: Some(3600),
            status: "completed".into(),
            fail_reason: None,
            filament_grams: Some(12.5),
            filament_meters: Some(4.2),
            thumbnail_path: Some("/path/to/thumb.png".into()),
            quality_profile: Some("0.20mm Standard".into()),
        };

        let json = serde_json::to_string(&record).expect("serialize");
        let back: PrintHistoryRecord = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(record, back);
    }

    #[test]
    fn extended_queued_job_backward_compat() {
        // JSON from before the extension (no filament fields) should still deserialize
        let old_json = r#"{
            "id": "old-1",
            "modelPath": "/tmp/model.stl",
            "threemfPath": "/tmp/model.3mf",
            "modelName": "Legacy Job",
            "createdAt": "2026-03-10T08:00:00Z",
            "status": "pending"
        }"#;

        let job: QueuedJob = serde_json::from_str(old_json).expect("should deserialize old format");
        assert_eq!(job.id, "old-1");
        assert_eq!(job.model_name, "Legacy Job");
        assert!(job.filament_grams.is_none());
        assert!(job.filament_meters.is_none());
        assert!(job.quality_profile.is_none());
        assert!(job.thumbnail_path.is_none());
    }

    // ─── T02: PrinterConfig → BambuCredentials tests ──────────────────────────

    #[test]
    fn printer_config_to_bambu_credentials_local_only() {
        use super::PrinterConfig;

        let config = PrinterConfig {
            id: "cfg-1".into(),
            name: "My P2S".into(),
            host: "192.0.2.136".into(),
            serial: "01P00A000000000".into(),
            access_code_keychain_id: "printer:cfg-1:access_code".into(),
            is_default: true,
            created_at: "2026-03-15T10:00:00Z".into(),
            updated_at: "2026-03-15T10:00:00Z".into(),
        };

        let creds = config.to_bambu_credentials("deadbeef", None);

        // Config fields map correctly
        assert_eq!(creds.printer.host, "192.0.2.136");
        assert_eq!(creds.printer.device_id, "01P00A000000000");
        assert_eq!(creds.printer.name, "My P2S");
        assert_eq!(creds.printer.access_code, "deadbeef");

        // Local-only: cloud fields are empty
        assert!(creds.access_token.is_empty());
        assert!(creds.user_id.is_empty());
        assert!(creds.user_name.is_none());
        assert!(creds.expires_at.is_none());

        // MQTT helpers work
        assert_eq!(creds.local_mqtt_username(), "bblp");
        assert_eq!(creds.local_mqtt_password(), "deadbeef");
        assert_eq!(creds.ftps_password(), "deadbeef");
        assert_eq!(creds.report_topic(), "device/01P00A000000000/report");
        assert_eq!(creds.request_topic(), "device/01P00A000000000/request");
    }

    #[test]
    fn printer_config_to_bambu_credentials_with_cloud() {
        use super::PrinterConfig;
        use crate::printer::BambuCredentials;
        use crate::printer::credentials::PrinterInfo;

        let config = PrinterConfig {
            id: "cfg-2".into(),
            name: "Office Printer".into(),
            host: "192.168.1.50".into(),
            serial: "SERIAL123".into(),
            access_code_keychain_id: "printer:cfg-2:access_code".into(),
            is_default: false,
            created_at: "2026-03-15T10:00:00Z".into(),
            updated_at: "2026-03-15T10:00:00Z".into(),
        };

        let cloud_creds = BambuCredentials {
            access_token: "cloud-token-xyz".into(),
            user_id: "u99999".into(),
            user_name: Some("clouduser".into()),
            printer: PrinterInfo {
                name: "CloudName".into(),
                device_id: "CLOUDSERIAL".into(),
                model: "X1C".into(),
                access_code: "cloudcode".into(),
                host: "cloud.example.com".into(),
            },
            expires_at: None,
            created_at: None,
        };

        let creds = config.to_bambu_credentials("localcode", Some(&cloud_creds));

        // Config fields override cloud printer info
        assert_eq!(creds.printer.host, "192.168.1.50");
        assert_eq!(creds.printer.device_id, "SERIAL123");
        assert_eq!(creds.printer.name, "Office Printer");
        assert_eq!(creds.printer.access_code, "localcode");

        // Cloud auth fields are pulled from cloud_creds
        assert_eq!(creds.access_token, "cloud-token-xyz");
        assert_eq!(creds.user_id, "u99999");
        assert_eq!(creds.user_name.as_deref(), Some("clouduser"));

        // Cloud MQTT username uses cloud user_id
        assert_eq!(creds.cloud_mqtt_username(), "u_u99999");
    }

    #[test]
    fn selected_printer_id_in_snapshot() {
        let state = AppState::default();

        // Default: no selected printer
        let snapshot = state.snapshot().expect("snapshot");
        assert!(snapshot.selected_printer_id.is_none());

        // Set a selected printer
        *state.selected_printer_id.lock().unwrap() = Some("cfg-abc".into());

        let snapshot = state.snapshot().expect("snapshot");
        assert_eq!(snapshot.selected_printer_id.as_deref(), Some("cfg-abc"));
    }

    #[test]
    fn selected_printer_id_serializes_in_json() {
        let state = AppState::default();
        *state.selected_printer_id.lock().unwrap() = Some("cfg-test".into());

        let snapshot = state.snapshot().expect("snapshot");
        let json = serde_json::to_value(&snapshot).expect("serialize");

        assert_eq!(json["selectedPrinterId"], "cfg-test");
    }

    #[test]
    fn selected_printer_id_null_when_none() {
        let state = AppState::default();
        let snapshot = state.snapshot().expect("snapshot");
        let json = serde_json::to_value(&snapshot).expect("serialize");

        assert!(json["selectedPrinterId"].is_null());
    }
}
