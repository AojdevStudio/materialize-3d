use serde::Deserialize;

use crate::state::{AmsUnitState, AmsTrayState, CameraStatus, PrinterState};

// ─── Inbound: MQTT report messages ────────────────────────────────────────────

/// Top-level MQTT message envelope from `device/{serial}/report`.
#[derive(Debug, Deserialize, Clone)]
pub struct BambuReport {
    #[serde(default)]
    pub print: Option<PushStatus>,
}

/// `push_status` payload — fields are all optional because P2S sends delta updates.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct PushStatus {
    #[serde(default)]
    pub nozzle_temper: Option<f64>,
    #[serde(default)]
    pub nozzle_target_temper: Option<f64>,
    #[serde(default)]
    pub bed_temper: Option<f64>,
    #[serde(default)]
    pub bed_target_temper: Option<f64>,
    #[serde(default)]
    pub chamber_temper: Option<f64>,
    #[serde(default)]
    pub gcode_state: Option<String>,
    #[serde(default)]
    pub mc_percent: Option<u8>,
    #[serde(default)]
    pub mc_remaining_time: Option<u32>,
    #[serde(default)]
    pub layer_num: Option<u32>,
    #[serde(default)]
    pub total_layer_num: Option<u32>,
    #[serde(default)]
    pub wifi_signal: Option<String>,
    #[serde(default)]
    pub subtask_name: Option<String>,
    #[serde(default)]
    pub ams: Option<AmsReport>,
    /// IP camera state from the printer.
    #[serde(default)]
    pub ipcam: Option<IpcamReport>,
    /// Command type echoed by the printer (e.g. "push_status").
    #[serde(default)]
    #[allow(dead_code)]
    pub command: Option<String>,
    /// Sequence id — present on every report.
    #[serde(default)]
    #[allow(dead_code)]
    pub sequence_id: Option<String>,
    /// Gcode start time — when the print started (ISO 8601 or epoch).
    #[serde(default)]
    pub gcode_start_time: Option<String>,
    /// Currently printing gcode file name.
    #[serde(default)]
    pub gcode_file: Option<String>,
    /// Reason for print failure, if any.
    #[serde(default)]
    pub fail_reason: Option<String>,
}

/// IP camera state reported in `push_status` payloads.
///
/// Per OpenBambuAPI, the `ipcam` object contains camera status fields.
/// `ipcam_dev` indicates whether the camera is enabled ("1") or disabled ("0").
#[derive(Debug, Deserialize, Clone, Default)]
pub struct IpcamReport {
    /// Camera device state: "1" = enabled, "0" = disabled.
    #[serde(default)]
    pub ipcam_dev: Option<String>,
    /// Recording state: "enable" or "disable".
    #[serde(default)]
    pub ipcam_record: Option<String>,
    /// Camera resolution, e.g. "1080p".
    #[serde(default)]
    pub resolution: Option<String>,
    /// Timelapse mode.
    #[serde(default)]
    pub timelapse: Option<String>,
    /// TUTK P2P server address.
    #[serde(default)]
    pub tutk_server: Option<String>,
}

/// AMS container — the printer wraps AMS units in an `ams` array.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct AmsReport {
    #[serde(default)]
    pub ams: Vec<AmsUnitReport>,
}

/// A single AMS unit with up to 4 trays.
#[derive(Debug, Deserialize, Clone, Default)]
pub struct AmsUnitReport {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub tray: Vec<AmsTrayReport>,
}

/// A single AMS tray (filament slot).
#[derive(Debug, Deserialize, Clone, Default)]
pub struct AmsTrayReport {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub tray_type: Option<String>,
    #[serde(default)]
    pub tray_color: Option<String>,
}

impl PushStatus {
    /// Merge a (possibly partial) push_status report into the live `PrinterState`.
    /// Only overwrites fields that are `Some` in the report — delta-safe.
    pub fn merge_into(&self, state: &mut PrinterState) {
        if let Some(v) = self.nozzle_temper {
            state.nozzle_temp = Some(v as f32);
        }
        if let Some(v) = self.nozzle_target_temper {
            state.nozzle_target_temp = Some(v as f32);
        }
        if let Some(v) = self.bed_temper {
            state.bed_temp = Some(v as f32);
        }
        if let Some(v) = self.bed_target_temper {
            state.bed_target_temp = Some(v as f32);
        }
        if let Some(v) = self.chamber_temper {
            state.chamber_temp = Some(v as f32);
        }
        if let Some(ref v) = self.gcode_state {
            state.gcode_state = Some(v.clone());
        }
        if let Some(v) = self.mc_percent {
            state.print_progress = Some(v);
        }
        if let Some(v) = self.mc_remaining_time {
            state.remaining_time = Some(v);
        }
        if let Some(v) = self.layer_num {
            state.layer_num = Some(v);
        }
        if let Some(v) = self.total_layer_num {
            state.total_layer_num = Some(v);
        }
        if let Some(ref v) = self.wifi_signal {
            state.wifi_signal = Some(v.clone());
        }
        if let Some(ref v) = self.subtask_name {
            state.subtask_name = Some(v.clone());
        }
        if let Some(ref v) = self.gcode_start_time {
            state.gcode_start_time = Some(v.clone());
        }
        if let Some(ref v) = self.gcode_file {
            state.gcode_file = Some(v.clone());
        }
        if let Some(ref v) = self.fail_reason {
            state.fail_reason = Some(v.clone());
        }
        if let Some(ref ams) = self.ams {
            state.ams_state = ams
                .ams
                .iter()
                .map(|unit| AmsUnitState {
                    id: unit.id.as_ref().and_then(|s| s.parse::<u8>().ok()),
                    trays: unit
                        .tray
                        .iter()
                        .map(|t| AmsTrayState {
                            tray_id: t.id.as_ref().and_then(|s| s.parse::<u8>().ok()),
                            tray_type: t.tray_type.clone(),
                            tray_color: t.tray_color.clone(),
                        })
                        .collect(),
                })
                .collect();
        }

        // Merge ipcam state into camera_state
        if let Some(ref ipcam) = self.ipcam {
            let enabled = ipcam.ipcam_dev.as_deref() == Some("1");
            if enabled {
                // Camera is enabled — construct snapshot URL from printer IP
                if let Some(ref ip) = state.printer_ip {
                    let url = format!("http://{}:6000/", ip);
                    state.camera_state.status = CameraStatus::Available;
                    state.camera_state.url = Some(url);
                    state.camera_state.diagnostic = None;
                } else {
                    state.camera_state.status = CameraStatus::Available;
                    state.camera_state.diagnostic =
                        Some("Camera enabled but printer IP not known".into());
                }
            } else {
                state.camera_state.status = CameraStatus::Unavailable;
                state.camera_state.url = None;
                state.camera_state.diagnostic =
                    Some("P2S camera not enabled (ipcam_dev=0)".into());
            }
        }
    }
}

// ─── Outbound: Commands to printer ────────────────────────────────────────────

/// Commands that can be sent to `device/{serial}/request`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BambuCommand {
    /// Request full printer state dump.
    PushAll,
    /// Pause the active print.
    Pause,
    /// Resume a paused print.
    Resume,
    /// Stop the active print.
    #[allow(dead_code)]
    Stop,
    /// Get firmware version info.
    #[allow(dead_code)]
    GetVersion,
    /// Start a print from a file already uploaded to the printer.
    ProjectFile {
        /// Gcode metadata path inside the 3MF, e.g. `"Metadata/plate_1.gcode"`.
        param: String,
        /// Human-readable name displayed on the printer screen.
        subtask_name: String,
        /// FTP URL of the uploaded 3MF, e.g. `"ftp:///cache/model.3mf"`.
        url: String,
        /// Hex MD5 digest of the uploaded 3MF file.
        md5: String,
        /// Whether to use AMS for filament.
        use_ams: bool,
        /// AMS slot mapping string (empty for external spool).
        ams_mapping: String,
    },
}

impl BambuCommand {
    /// Serialize the command to the JSON string expected by the Bambu MQTT protocol.
    pub fn to_json(&self) -> String {
        match self {
            BambuCommand::PushAll => serde_json::json!({
                "pushing": {
                    "sequence_id": "0",
                    "command": "pushall"
                }
            })
            .to_string(),
            BambuCommand::Pause => serde_json::json!({
                "print": {
                    "sequence_id": "0",
                    "command": "pause",
                    "param": ""
                }
            })
            .to_string(),
            BambuCommand::Resume => serde_json::json!({
                "print": {
                    "sequence_id": "0",
                    "command": "resume",
                    "param": ""
                }
            })
            .to_string(),
            BambuCommand::Stop => serde_json::json!({
                "print": {
                    "sequence_id": "0",
                    "command": "stop",
                    "param": ""
                }
            })
            .to_string(),
            BambuCommand::GetVersion => serde_json::json!({
                "info": {
                    "sequence_id": "0",
                    "command": "get_version"
                }
            })
            .to_string(),
            BambuCommand::ProjectFile {
                ref param,
                ref subtask_name,
                ref url,
                ref md5,
                use_ams,
                ref ams_mapping,
            } => serde_json::json!({
                "print": {
                    "sequence_id": "0",
                    "command": "project_file",
                    "param": param,
                    "subtask_name": subtask_name,
                    "url": url,
                    "md5": md5,
                    "timelapse": false,
                    "bed_leveling": true,
                    "flow_cali": true,
                    "vibration_cali": true,
                    "layer_inspect": false,
                    "use_ams": use_ams,
                    "ams_mapping": ams_mapping,
                    "profile_id": "0",
                    "project_id": "0",
                    "subtask_id": "0",
                    "task_id": "0"
                }
            })
            .to_string(),
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Realistic pushall payload from a P2S (trimmed to key fields).
    const PUSHALL_JSON: &str = r#"{
        "print": {
            "command": "push_status",
            "sequence_id": "2038",
            "nozzle_temper": 25.5,
            "nozzle_target_temper": 0.0,
            "bed_temper": 27.0,
            "bed_target_temper": 0.0,
            "chamber_temper": 22.0,
            "gcode_state": "IDLE",
            "mc_percent": 0,
            "mc_remaining_time": 0,
            "layer_num": 0,
            "total_layer_num": 0,
            "wifi_signal": "-42dBm",
            "subtask_name": "",
            "ams": {
                "ams": [
                    {
                        "id": "0",
                        "tray": [
                            {"id": "0", "tray_type": "PLA", "tray_color": "FF0000"},
                            {"id": "1", "tray_type": "PETG", "tray_color": "00FF00"},
                            {"id": "2", "tray_type": "", "tray_color": ""},
                            {"id": "3", "tray_type": "", "tray_color": ""}
                        ]
                    }
                ]
            }
        }
    }"#;

    #[test]
    fn deserialize_pushall_report() {
        let report: BambuReport =
            serde_json::from_str(PUSHALL_JSON).expect("should deserialize pushall");
        let status = report.print.expect("print field should be present");

        assert_eq!(status.nozzle_temper, Some(25.5));
        assert_eq!(status.bed_temper, Some(27.0));
        assert_eq!(status.chamber_temper, Some(22.0));
        assert_eq!(status.gcode_state.as_deref(), Some("IDLE"));
        assert_eq!(status.mc_percent, Some(0));
        assert_eq!(status.wifi_signal.as_deref(), Some("-42dBm"));

        let ams = status.ams.expect("ams should be present");
        assert_eq!(ams.ams.len(), 1);
        assert_eq!(ams.ams[0].tray.len(), 4);
        assert_eq!(ams.ams[0].tray[0].tray_type.as_deref(), Some("PLA"));
        assert_eq!(ams.ams[0].tray[0].tray_color.as_deref(), Some("FF0000"));
    }

    #[test]
    fn delta_merge_only_overwrites_present_fields() {
        let mut state = PrinterState {
            nozzle_temp: Some(200.0),
            bed_temp: Some(60.0),
            gcode_state: Some("PRINTING".into()),
            subtask_name: Some("benchy.gcode".into()),
            ..Default::default()
        };

        // Delta update: only nozzle temp changed
        let delta: BambuReport = serde_json::from_str(
            r#"{"print": {"nozzle_temper": 205.3}}"#,
        )
        .unwrap();
        delta.print.unwrap().merge_into(&mut state);

        // Nozzle updated
        assert_eq!(state.nozzle_temp, Some(205.3));
        // Other fields preserved
        assert_eq!(state.bed_temp, Some(60.0));
        assert_eq!(state.gcode_state.as_deref(), Some("PRINTING"));
        assert_eq!(state.subtask_name.as_deref(), Some("benchy.gcode"));
    }

    #[test]
    fn full_merge_from_pushall() {
        let mut state = PrinterState::default();
        let report: BambuReport = serde_json::from_str(PUSHALL_JSON).unwrap();
        report.print.unwrap().merge_into(&mut state);

        assert_eq!(state.nozzle_temp, Some(25.5));
        assert_eq!(state.bed_temp, Some(27.0));
        assert_eq!(state.chamber_temp, Some(22.0));
        assert_eq!(state.gcode_state.as_deref(), Some("IDLE"));
        assert_eq!(state.ams_state.len(), 1);
        assert_eq!(state.ams_state[0].trays.len(), 4);
        assert_eq!(
            state.ams_state[0].trays[0].tray_type.as_deref(),
            Some("PLA")
        );
    }

    #[test]
    fn command_pushall_json() {
        let json = BambuCommand::PushAll.to_json();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["pushing"]["command"], "pushall");
        assert_eq!(val["pushing"]["sequence_id"], "0");
    }

    #[test]
    fn command_pause_json() {
        let json = BambuCommand::Pause.to_json();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["print"]["command"], "pause");
    }

    #[test]
    fn command_resume_json() {
        let json = BambuCommand::Resume.to_json();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["print"]["command"], "resume");
    }

    #[test]
    fn command_stop_json() {
        let json = BambuCommand::Stop.to_json();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["print"]["command"], "stop");
    }

    #[test]
    fn command_get_version_json() {
        let json = BambuCommand::GetVersion.to_json();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["info"]["command"], "get_version");
    }

    #[test]
    fn command_project_file_json() {
        let cmd = BambuCommand::ProjectFile {
            param: "Metadata/plate_1.gcode".into(),
            subtask_name: "benchy".into(),
            url: "ftp:///cache/benchy.3mf".into(),
            md5: "d41d8cd98f00b204e9800998ecf8427e".into(),
            use_ams: false,
            ams_mapping: String::new(),
        };
        let json = cmd.to_json();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();

        assert_eq!(val["print"]["command"], "project_file");
        assert_eq!(val["print"]["param"], "Metadata/plate_1.gcode");
        assert_eq!(val["print"]["subtask_name"], "benchy");
        assert_eq!(val["print"]["url"], "ftp:///cache/benchy.3mf");
        assert_eq!(val["print"]["md5"], "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(val["print"]["use_ams"], false);
        assert_eq!(val["print"]["ams_mapping"], "");
        assert_eq!(val["print"]["timelapse"], false);
        assert_eq!(val["print"]["bed_leveling"], true);
        assert_eq!(val["print"]["flow_cali"], true);
        assert_eq!(val["print"]["vibration_cali"], true);
        assert_eq!(val["print"]["layer_inspect"], false);
        assert_eq!(val["print"]["profile_id"], "0");
        assert_eq!(val["print"]["project_id"], "0");
        assert_eq!(val["print"]["subtask_id"], "0");
        assert_eq!(val["print"]["task_id"], "0");
        assert_eq!(val["print"]["sequence_id"], "0");
    }

    #[test]
    fn deserialize_unknown_fields_gracefully() {
        // Printer might send fields we don't model — should not panic
        let json = r#"{
            "print": {
                "command": "push_status",
                "unknown_field_xyz": 42,
                "nozzle_temper": 100.0,
                "stg_cur": 3,
                "fan_gear": 15
            }
        }"#;
        let report: BambuReport = serde_json::from_str(json).expect("should handle unknown fields");
        let status = report.print.unwrap();
        assert_eq!(status.nozzle_temper, Some(100.0));
    }

    // ─── ipcam deserialization & camera state merge ───────────────────────────

    #[test]
    fn deserialize_ipcam_field() {
        let json = r#"{
            "print": {
                "command": "push_status",
                "nozzle_temper": 200.0,
                "ipcam": {
                    "ipcam_dev": "1",
                    "ipcam_record": "enable",
                    "resolution": "1080p",
                    "timelapse": "disable",
                    "tutk_server": "some-server"
                }
            }
        }"#;
        let report: BambuReport = serde_json::from_str(json).expect("should deserialize ipcam");
        let status = report.print.unwrap();
        let ipcam = status.ipcam.expect("ipcam should be present");
        assert_eq!(ipcam.ipcam_dev.as_deref(), Some("1"));
        assert_eq!(ipcam.ipcam_record.as_deref(), Some("enable"));
        assert_eq!(ipcam.resolution.as_deref(), Some("1080p"));
    }

    #[test]
    fn ipcam_absent_doesnt_crash() {
        // The existing PUSHALL_JSON has no ipcam field — should still parse fine
        let report: BambuReport =
            serde_json::from_str(PUSHALL_JSON).expect("should deserialize without ipcam");
        let status = report.print.unwrap();
        assert!(status.ipcam.is_none());
    }

    #[test]
    fn ipcam_merge_sets_camera_available_with_ip() {
        let mut state = PrinterState {
            printer_ip: Some("192.0.2.136".into()),
            ..Default::default()
        };

        let json = r#"{"print": {"ipcam": {"ipcam_dev": "1"}}}"#;
        let report: BambuReport = serde_json::from_str(json).unwrap();
        report.print.unwrap().merge_into(&mut state);

        assert_eq!(state.camera_state.status, CameraStatus::Available);
        assert_eq!(
            state.camera_state.url.as_deref(),
            Some("http://192.0.2.136:6000/")
        );
        assert!(state.camera_state.diagnostic.is_none());
    }

    #[test]
    fn ipcam_merge_sets_camera_unavailable_when_disabled() {
        let mut state = PrinterState {
            printer_ip: Some("192.0.2.136".into()),
            ..Default::default()
        };

        let json = r#"{"print": {"ipcam": {"ipcam_dev": "0"}}}"#;
        let report: BambuReport = serde_json::from_str(json).unwrap();
        report.print.unwrap().merge_into(&mut state);

        assert_eq!(state.camera_state.status, CameraStatus::Unavailable);
        assert!(state.camera_state.url.is_none());
        assert!(state
            .camera_state
            .diagnostic
            .as_ref()
            .unwrap()
            .contains("not enabled"));
    }

    #[test]
    fn ipcam_merge_without_printer_ip_still_sets_available() {
        let mut state = PrinterState::default();
        assert!(state.printer_ip.is_none());

        let json = r#"{"print": {"ipcam": {"ipcam_dev": "1"}}}"#;
        let report: BambuReport = serde_json::from_str(json).unwrap();
        report.print.unwrap().merge_into(&mut state);

        assert_eq!(state.camera_state.status, CameraStatus::Available);
        // No URL since we don't know the IP
        assert!(state.camera_state.url.is_none());
        assert!(state
            .camera_state
            .diagnostic
            .as_ref()
            .unwrap()
            .contains("IP not known"));
    }

    #[test]
    fn push_status_parses_start_time_and_fail_reason() {
        let json = r#"{
            "print": {
                "command": "push_status",
                "gcode_state": "FAILED",
                "gcode_start_time": "2026-03-15T10:30:00Z",
                "gcode_file": "benchy.gcode",
                "fail_reason": "Nozzle clog detected"
            }
        }"#;
        let report: BambuReport = serde_json::from_str(json).expect("should parse new fields");
        let status = report.print.unwrap();

        assert_eq!(status.gcode_start_time.as_deref(), Some("2026-03-15T10:30:00Z"));
        assert_eq!(status.gcode_file.as_deref(), Some("benchy.gcode"));
        assert_eq!(status.fail_reason.as_deref(), Some("Nozzle clog detected"));
        assert_eq!(status.gcode_state.as_deref(), Some("FAILED"));
    }

    #[test]
    fn merge_preserves_new_fields_on_delta() {
        let mut state = PrinterState {
            gcode_start_time: Some("2026-03-15T10:30:00Z".into()),
            gcode_file: Some("benchy.gcode".into()),
            fail_reason: Some("Nozzle clog".into()),
            ..Default::default()
        };

        // Delta update that doesn't include the new fields — should preserve existing values
        let delta: BambuReport = serde_json::from_str(
            r#"{"print": {"nozzle_temper": 210.0}}"#,
        )
        .unwrap();
        delta.print.unwrap().merge_into(&mut state);

        assert_eq!(state.gcode_start_time.as_deref(), Some("2026-03-15T10:30:00Z"));
        assert_eq!(state.gcode_file.as_deref(), Some("benchy.gcode"));
        assert_eq!(state.fail_reason.as_deref(), Some("Nozzle clog"));
        assert_eq!(state.nozzle_temp, Some(210.0));
    }

    #[test]
    fn merge_overwrites_new_fields_when_present() {
        let mut state = PrinterState {
            gcode_start_time: Some("old-time".into()),
            gcode_file: Some("old-file.gcode".into()),
            ..Default::default()
        };

        let json = r#"{"print": {"gcode_start_time": "new-time", "gcode_file": "new-file.gcode", "fail_reason": "bed adhesion"}}"#;
        let report: BambuReport = serde_json::from_str(json).unwrap();
        report.print.unwrap().merge_into(&mut state);

        assert_eq!(state.gcode_start_time.as_deref(), Some("new-time"));
        assert_eq!(state.gcode_file.as_deref(), Some("new-file.gcode"));
        assert_eq!(state.fail_reason.as_deref(), Some("bed adhesion"));
    }
}
