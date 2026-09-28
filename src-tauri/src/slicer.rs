use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tempfile::TempDir;

// ─── Constants ────────────────────────────────────────────────────────────────

/// OrcaSlicer is used instead of BambuStudio CLI because BambuStudio CLI has a
/// known segfault bug with P2S 0.4 nozzle profiles (GitHub #9636).
/// Primary OrcaSlicer CLI location for the current OS (used as the fallback
/// path when detection finds nothing, e.g. for error messages).
#[cfg(target_os = "macos")]
pub const ORCA_CLI: &str = "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer";
#[cfg(target_os = "windows")]
pub const ORCA_CLI: &str = r"C:\Program Files\OrcaSlicer\orca-slicer.exe";
#[cfg(all(unix, not(target_os = "macos")))]
pub const ORCA_CLI: &str = "/usr/bin/orca-slicer";


const MACHINE_PROFILE: &str = "Bambu Lab P2S 0.4 nozzle.json";

/// Simplified gcode templates compatible with OrcaSlicer's parser.
/// BambuStudio profiles use variables like `min_vitrification_temperature` that
/// OrcaSlicer doesn't support. These simplified versions produce valid gcode
/// for the P2S — the actual start/end gcode is embedded in the printer firmware.
pub const ORCA_MACHINE_START_GCODE: &str =
    "G28\\nG1 Z5 F5000\\nM104 S[nozzle_temperature_initial_layer]\\nM140 S[bed_temperature_initial_layer_single]\\nM109 S[nozzle_temperature_initial_layer]\\nM190 S[bed_temperature_initial_layer_single]\\nG92 E0\\n";

pub const ORCA_MACHINE_END_GCODE: &str =
    "G1 E-2 F2400\\nG28 X\\nM104 S0\\nM140 S0\\nM84\\n";

pub const ORCA_LAYER_CHANGE_GCODE: &str =
    "G92 E0\\n;LAYER_CHANGE\\n;Z:[layer_z]\\nM73 L[layer_num]\\n";

/// Skip these keys when inlining template includes into the machine profile.
const INCLUDE_SKIP_KEYS: &[&str] = &["name", "instantiation", "type", "from"];

// ─── Profile Maps ─────────────────────────────────────────────────────────────

/// Maps quality layer-height strings to process profile filenames.
/// Ported exactly from TS `profiles.ts` `PROCESS_MAP`.
fn process_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("0.08", "0.08mm High Quality @BBL P2S.json"),
        ("0.12", "0.12mm High Quality @BBL P2S.json"),
        ("0.16", "0.16mm Standard @BBL P2S.json"),
        ("0.20", "0.20mm Standard @BBL P2S.json"),
        ("0.24", "0.24mm Standard @BBL P2S.json"),
    ])
}

/// Maps filament display names to filament profile filenames.
/// Ported exactly from TS `profiles.ts` `FILAMENT_MAP`.
fn filament_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("Bambu PLA Basic", "Bambu PLA Basic @BBL P2S.json"),
        ("Bambu PLA Matte", "Bambu PLA Matte @BBL P2S.json"),
        (
            "Bambu PETG Basic",
            "Bambu PETG Basic @BBL P2S 0.4 nozzle.json",
        ),
        ("Generic PLA", "Generic PLA @BBL P2S.json"),
        ("Generic PETG", "Generic PETG @BBL P2S.json"),
    ])
}

// ─── Error Type ───────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SlicerError {
    #[error("OrcaSlicer CLI not found at {path}. Install: {}", crate::platform::install_hint("orcaslicer"))]
    MissingCli { path: String },

    #[error("BambuStudio profiles not found at {path}. Please install BambuStudio and run it once to download profiles.")]
    MissingProfiles { path: String },

    #[error("input file not found: {path}")]
    MissingInput { path: String },

    #[error("unknown quality \"{quality}\". Valid: {valid}")]
    UnknownQuality { quality: String, valid: String },

    #[error("unknown filament \"{filament}\". Valid: {valid}")]
    UnknownFilament { filament: String, valid: String },

    #[error("OrcaSlicer exited with code {exit_code}\nstdout: {stdout}\nstderr: {stderr}")]
    SliceFailed {
        exit_code: i32,
        stdout: String,
        stderr: String,
    },

    #[error("slicing completed but output file not found at {path}\nstdout: {stdout}\nstderr: {stderr}")]
    OutputMissing {
        path: String,
        stdout: String,
        stderr: String,
    },

    #[error("failed to parse 3MF: {reason}")]
    ParseError { reason: String },

    #[error("profile patching failed: {reason}")]
    PatchError { reason: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceInput {
    pub input_files: Vec<PathBuf>,
    pub output_file: PathBuf,
    pub quality: String,
    pub filament: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedProfiles {
    pub machine: PathBuf,
    pub process: PathBuf,
    pub filament: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileList {
    pub qualities: Vec<String>,
    pub filaments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceEstimates {
    pub time_seconds: u64,
    pub filament_meters: f64,
    pub filament_grams: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceResult {
    pub success: bool,
    pub output_file: PathBuf,
    pub estimates: Option<SliceEstimates>,
    pub error: Option<String>,
}

// ─── Service ──────────────────────────────────────────────────────────────────

/// Stateless slicer service holding configuration paths.
#[derive(Debug, Clone)]
pub struct SlicerService {
    pub orca_cli_path: PathBuf,
    pub profile_base_path: PathBuf,
}

impl Default for SlicerService {
    fn default() -> Self {
        Self {
            orca_cli_path: crate::platform::detect_orca_slicer()
                .unwrap_or_else(|| PathBuf::from(ORCA_CLI)),
            profile_base_path: crate::platform::bambu_profile_base()
                .unwrap_or_else(|| PathBuf::from(".")),
        }
    }
}

impl SlicerService {
    /// Check that OrcaSlicer CLI and profile directory exist.
    pub fn validate(&self) -> Result<(), SlicerError> {
        if !self.orca_cli_path.exists() {
            return Err(SlicerError::MissingCli {
                path: self.orca_cli_path.display().to_string(),
            });
        }
        if !self.profile_base_path.exists() {
            return Err(SlicerError::MissingProfiles {
                path: self.profile_base_path.display().to_string(),
            });
        }
        Ok(())
    }

    /// Resolve quality + filament names to absolute profile file paths.
    pub fn resolve_profiles(
        &self,
        quality: &str,
        filament: &str,
    ) -> Result<ResolvedProfiles, SlicerError> {
        let pmap = process_map();
        let fmap = filament_map();

        let process_file = pmap.get(quality).ok_or_else(|| {
            let valid = {
                let mut keys: Vec<&str> = pmap.keys().copied().collect();
                keys.sort();
                keys.join(", ")
            };
            SlicerError::UnknownQuality {
                quality: quality.to_string(),
                valid,
            }
        })?;

        let filament_file = fmap.get(filament).ok_or_else(|| {
            let valid = {
                let mut keys: Vec<&str> = fmap.keys().copied().collect();
                keys.sort();
                keys.join(", ")
            };
            SlicerError::UnknownFilament {
                filament: filament.to_string(),
                valid,
            }
        })?;

        Ok(ResolvedProfiles {
            machine: self.profile_base_path.join("machine").join(MACHINE_PROFILE),
            process: self.profile_base_path.join("process").join(process_file),
            filament: self.profile_base_path.join("filament").join(filament_file),
        })
    }

    /// List all available quality and filament options.
    pub fn list_profiles(&self) -> ProfileList {
        let mut qualities: Vec<String> = process_map().keys().map(|k| k.to_string()).collect();
        qualities.sort();
        let mut filaments: Vec<String> = filament_map().keys().map(|k| k.to_string()).collect();
        filaments.sort();
        ProfileList {
            qualities,
            filaments,
        }
    }

    /// Patch a BambuStudio machine profile to be OrcaSlicer-compatible.
    ///
    /// - Inlines template `include` entries from sibling JSON files
    /// - Replaces the 3 gcode fields with OrcaSlicer-compatible constants
    /// - Adds `nozzle_volume_type` if missing
    ///
    /// Returns `(TempDir, PathBuf)` — the TempDir owns the patched file and
    /// cleans up on drop. The PathBuf is the path to the patched JSON.
    pub fn patch_machine_profile(
        &self,
        machine_path: &Path,
    ) -> Result<(TempDir, PathBuf), SlicerError> {
        let content = std::fs::read_to_string(machine_path).map_err(|e| {
            SlicerError::PatchError {
                reason: format!("failed to read machine profile {}: {e}", machine_path.display()),
            }
        })?;

        let mut profile: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| SlicerError::PatchError {
                reason: format!("failed to parse machine profile JSON: {e}"),
            })?;

        let profile_dir = machine_path
            .parent()
            .ok_or_else(|| SlicerError::PatchError {
                reason: "machine profile has no parent directory".to_string(),
            })?;

        // Inline template includes
        if let Some(includes) = profile.get("include").and_then(|v| v.as_array()).cloned() {
            for inc in &includes {
                if let Some(inc_name) = inc.as_str() {
                    let tpath = profile_dir.join(format!("{inc_name}.json"));
                    if tpath.exists() {
                        let tpl_content = std::fs::read_to_string(&tpath).map_err(|e| {
                            SlicerError::PatchError {
                                reason: format!(
                                    "failed to read template {}: {e}",
                                    tpath.display()
                                ),
                            }
                        })?;
                        let template: serde_json::Value = serde_json::from_str(&tpl_content)
                            .map_err(|e| SlicerError::PatchError {
                                reason: format!(
                                    "failed to parse template JSON {}: {e}",
                                    tpath.display()
                                ),
                            })?;

                        if let Some(obj) = template.as_object() {
                            for (k, v) in obj {
                                if !INCLUDE_SKIP_KEYS.contains(&k.as_str()) {
                                    profile[k] = v.clone();
                                }
                            }
                        }
                    }
                }
            }
            // Remove include array after inlining
            if let Some(obj) = profile.as_object_mut() {
                obj.remove("include");
            }
        }

        // Replace gcode fields with OrcaSlicer-compatible versions
        profile["machine_start_gcode"] =
            serde_json::Value::String(ORCA_MACHINE_START_GCODE.to_string());
        profile["machine_end_gcode"] =
            serde_json::Value::String(ORCA_MACHINE_END_GCODE.to_string());
        profile["layer_change_gcode"] =
            serde_json::Value::String(ORCA_LAYER_CHANGE_GCODE.to_string());

        // Ensure nozzle_volume_type exists
        if profile.get("nozzle_volume_type").is_none() {
            profile["nozzle_volume_type"] =
                serde_json::Value::Array(vec![serde_json::Value::String("0".to_string())]);
        }

        // Write patched profile to temp directory
        let tmp_dir = TempDir::new().map_err(|e| SlicerError::PatchError {
            reason: format!("failed to create temp dir: {e}"),
        })?;
        let patched_path = tmp_dir.path().join("machine-patched.json");
        let patched_json = serde_json::to_string_pretty(&profile).map_err(|e| {
            SlicerError::PatchError {
                reason: format!("failed to serialize patched profile: {e}"),
            }
        })?;
        std::fs::write(&patched_path, patched_json)?;

        Ok((tmp_dir, patched_path))
    }

    /// Build the CLI argument array for OrcaSlicer.
    ///
    /// All paths are canonicalized to absolute before inclusion.
    pub fn build_slice_args(
        &self,
        input_files: &[PathBuf],
        output_file: &Path,
        machine_path: &Path,
        process_path: &Path,
        filament_path: &Path,
    ) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();

        // Input files first
        for f in input_files {
            args.push(f.display().to_string());
        }

        // --load-settings machine;process
        args.push("--load-settings".to_string());
        args.push(format!(
            "{};{}",
            machine_path.display(),
            process_path.display()
        ));

        // --load-filaments
        args.push("--load-filaments".to_string());
        args.push(filament_path.display().to_string());

        // Fixed flags
        args.push("--arrange".to_string());
        args.push("1".to_string());
        args.push("--orient".to_string());
        args.push("1".to_string());
        args.push("--slice".to_string());
        args.push("0".to_string());

        // Output
        args.push("--export-3mf".to_string());
        args.push(output_file.display().to_string());

        args
    }

    /// Run OrcaSlicer on the given input, returning a SliceResult.
    ///
    /// Validates prerequisites, resolves profiles, patches the machine profile,
    /// runs the CLI subprocess, and extracts estimates from the output 3MF.
    pub async fn run_slicer(&self, input: &SliceInput) -> Result<SliceResult, SlicerError> {
        let start = Instant::now();

        // Validate CLI exists
        if !self.orca_cli_path.exists() {
            return Err(SlicerError::MissingCli {
                path: self.orca_cli_path.display().to_string(),
            });
        }

        // Validate input files exist and canonicalize
        let mut canonical_inputs = Vec::new();
        for f in &input.input_files {
            if !f.exists() {
                return Err(SlicerError::MissingInput {
                    path: f.display().to_string(),
                });
            }
            canonical_inputs.push(std::fs::canonicalize(f)?);
        }

        // Canonicalize output path (parent must exist)
        let output_abs = if input.output_file.is_absolute() {
            input.output_file.clone()
        } else {
            std::env::current_dir()?.join(&input.output_file)
        };

        // Resolve profiles
        let profiles = self.resolve_profiles(&input.quality, &input.filament)?;

        log::info!(
            "slice start: model={:?}, quality={}, filament={}",
            input.input_files,
            input.quality,
            input.filament
        );

        // Patch machine profile
        let (_tmp_dir, patched_machine) = self.patch_machine_profile(&profiles.machine)?;

        // Build args with absolute paths
        let args = self.build_slice_args(
            &canonical_inputs,
            &output_abs,
            &patched_machine,
            &profiles.process,
            &profiles.filament,
        );

        // Run OrcaSlicer
        let output = tokio::process::Command::new(&self.orca_cli_path)
            .args(&args)
            .output()
            .await?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        // Determine success by exit code (stderr GL noise is expected)
        if !output.status.success() {
            let exit_code = output.status.code().unwrap_or(-1);
            log::error!(
                "slice error: exit_code={exit_code}, stderr={}",
                &stderr[..stderr.len().min(500)]
            );
            return Err(SlicerError::SliceFailed {
                exit_code,
                stdout,
                stderr,
            });
        }

        // Verify output file exists (OrcaSlicer can exit 0 with no output on relative paths)
        if !output_abs.exists() {
            log::error!("slice error: output file missing at {}", output_abs.display());
            return Err(SlicerError::OutputMissing {
                path: output_abs.display().to_string(),
                stdout,
                stderr,
            });
        }

        // Extract estimates from 3MF
        let estimates = match parse_slice_info(&output_abs) {
            Ok(est) => {
                log::info!(
                    "slice complete: duration={:?}, time_est={}s, filament={:.2}m / {:.1}g",
                    start.elapsed(),
                    est.time_seconds,
                    est.filament_meters,
                    est.filament_grams
                );
                Some(est)
            }
            Err(e) => {
                log::warn!("failed to parse slice estimates: {e}");
                None
            }
        };

        // _tmp_dir drops here, cleaning up the patched profile

        Ok(SliceResult {
            success: true,
            output_file: output_abs,
            estimates,
            error: None,
        })
    }
}

// ─── 3MF Parsing ──────────────────────────────────────────────────────────────

/// Parse `Metadata/slice_info.config` from a 3MF (ZIP) file to extract
/// print time and filament usage estimates.
pub fn parse_slice_info(path_3mf: &Path) -> Result<SliceEstimates, SlicerError> {
    let file = std::fs::File::open(path_3mf).map_err(|e| SlicerError::ParseError {
        reason: format!("failed to open 3MF: {e}"),
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| SlicerError::ParseError {
        reason: format!("failed to read 3MF as ZIP: {e}"),
    })?;

    let mut slice_info = archive
        .by_name("Metadata/slice_info.config")
        .map_err(|e| SlicerError::ParseError {
            reason: format!("slice_info.config not found in 3MF: {e}"),
        })?;

    let mut xml_content = String::new();
    slice_info
        .read_to_string(&mut xml_content)
        .map_err(|e| SlicerError::ParseError {
            reason: format!("failed to read slice_info.config: {e}"),
        })?;

    parse_slice_info_xml(&xml_content)
}

/// Parse the XML content of `slice_info.config` to extract estimates.
///
/// Expected structure:
/// ```xml
/// <config>
///   <plate>
///     <metadata key="prediction" value="631"/>
///     <filament id="1" type="PLA" used_m="1.29" used_g="0.00"/>
///   </plate>
/// </config>
/// ```
pub fn parse_slice_info_xml(xml: &str) -> Result<SliceEstimates, SlicerError> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);

    let mut time_seconds: u64 = 0;
    let mut filament_meters: f64 = 0.0;
    let mut filament_grams: f64 = 0.0;

    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e)) => {
                let tag = e.name();
                let tag_str = std::str::from_utf8(tag.as_ref()).unwrap_or("");

                if tag_str == "metadata" {
                    // Look for <metadata key="prediction" value="NNN"/>
                    let mut is_prediction = false;
                    let mut val = String::new();
                    for attr in e.attributes().flatten() {
                        let key =
                            std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                        let value = std::str::from_utf8(&attr.value).unwrap_or("");
                        if key == "key" && value == "prediction" {
                            is_prediction = true;
                        }
                        if key == "value" {
                            val = value.to_string();
                        }
                    }
                    if is_prediction {
                        time_seconds = val.parse().unwrap_or(0);
                    }
                } else if tag_str == "filament" {
                    // Look for <filament ... used_m="1.29" used_g="0.00"/>
                    for attr in e.attributes().flatten() {
                        let key =
                            std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                        let value = std::str::from_utf8(&attr.value).unwrap_or("");
                        if key == "used_m" {
                            filament_meters += value.parse::<f64>().unwrap_or(0.0);
                        }
                        if key == "used_g" {
                            filament_grams += value.parse::<f64>().unwrap_or(0.0);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(SlicerError::ParseError {
                    reason: format!("XML parse error: {e}"),
                });
            }
            _ => {}
        }
    }

    Ok(SliceEstimates {
        time_seconds,
        filament_meters,
        filament_grams,
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_service() -> SlicerService {
        SlicerService {
            orca_cli_path: PathBuf::from(ORCA_CLI),
            profile_base_path: PathBuf::from("/test/profiles/BBL"),
        }
    }

    // ── build_slice_args ──────────────────────────────────────────────

    #[test]
    fn build_slice_args_single_input() {
        let svc = test_service();
        let args = svc.build_slice_args(
            &[PathBuf::from("/tmp/model.stl")],
            Path::new("/tmp/model.3mf"),
            Path::new("/profiles/machine.json"),
            Path::new("/profiles/process.json"),
            Path::new("/profiles/filament.json"),
        );

        assert_eq!(
            args,
            vec![
                "/tmp/model.stl",
                "--load-settings",
                "/profiles/machine.json;/profiles/process.json",
                "--load-filaments",
                "/profiles/filament.json",
                "--arrange",
                "1",
                "--orient",
                "1",
                "--slice",
                "0",
                "--export-3mf",
                "/tmp/model.3mf",
            ]
        );
    }

    #[test]
    fn build_slice_args_multiple_inputs() {
        let svc = test_service();
        let args = svc.build_slice_args(
            &[
                PathBuf::from("/tmp/box.stl"),
                PathBuf::from("/tmp/cylinder.stl"),
            ],
            Path::new("/tmp/multi.3mf"),
            Path::new("/profiles/machine.json"),
            Path::new("/profiles/process.json"),
            Path::new("/profiles/filament.json"),
        );

        // Multiple input files should all appear before --load-settings
        assert_eq!(args[0], "/tmp/box.stl");
        assert_eq!(args[1], "/tmp/cylinder.stl");
        assert!(args.contains(&"--export-3mf".to_string()));
        assert_eq!(args.last().unwrap(), "/tmp/multi.3mf");
    }

    // ── resolve_profiles ──────────────────────────────────────────────

    #[test]
    fn resolve_profiles_default() {
        let svc = test_service();
        let r = svc.resolve_profiles("0.20", "Bambu PLA Basic").unwrap();
        assert!(r.machine.to_str().unwrap().contains("Bambu Lab P2S 0.4 nozzle.json"));
        assert!(r.process.to_str().unwrap().contains("0.20mm Standard @BBL P2S.json"));
        assert!(r.filament.to_str().unwrap().contains("Bambu PLA Basic @BBL P2S.json"));
    }

    #[test]
    fn resolve_profiles_all_qualities() {
        let svc = test_service();
        let expected = vec![
            ("0.08", "0.08mm High Quality @BBL P2S.json"),
            ("0.12", "0.12mm High Quality @BBL P2S.json"),
            ("0.16", "0.16mm Standard @BBL P2S.json"),
            ("0.20", "0.20mm Standard @BBL P2S.json"),
            ("0.24", "0.24mm Standard @BBL P2S.json"),
        ];
        for (quality, expected_file) in expected {
            let r = svc.resolve_profiles(quality, "Bambu PLA Basic").unwrap();
            assert!(
                r.process.to_str().unwrap().contains(expected_file),
                "quality {quality} should resolve to {expected_file}"
            );
        }
    }

    #[test]
    fn resolve_profiles_all_filaments() {
        let svc = test_service();
        let expected = vec![
            ("Bambu PLA Basic", "Bambu PLA Basic @BBL P2S.json"),
            ("Bambu PLA Matte", "Bambu PLA Matte @BBL P2S.json"),
            (
                "Bambu PETG Basic",
                "Bambu PETG Basic @BBL P2S 0.4 nozzle.json",
            ),
            ("Generic PLA", "Generic PLA @BBL P2S.json"),
            ("Generic PETG", "Generic PETG @BBL P2S.json"),
        ];
        for (filament, expected_file) in expected {
            let r = svc.resolve_profiles("0.20", filament).unwrap();
            assert!(
                r.filament.to_str().unwrap().contains(expected_file),
                "filament {filament} should resolve to {expected_file}"
            );
        }
    }

    #[test]
    fn resolve_profiles_unknown_quality_errors() {
        let svc = test_service();
        let err = svc.resolve_profiles("0.99", "Bambu PLA Basic").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unknown quality"), "error: {msg}");
        assert!(msg.contains("0.99"), "error should include bad quality: {msg}");
    }

    #[test]
    fn resolve_profiles_unknown_filament_errors() {
        let svc = test_service();
        let err = svc.resolve_profiles("0.20", "Mystery").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unknown filament"), "error: {msg}");
        assert!(msg.contains("Mystery"), "error should include bad filament: {msg}");
    }

    // ── list_profiles ─────────────────────────────────────────────────

    #[test]
    fn list_profiles_returns_all_options() {
        let svc = test_service();
        let list = svc.list_profiles();
        assert_eq!(list.qualities.len(), 5, "should have 5 qualities");
        assert_eq!(list.filaments.len(), 5, "should have 5 filaments");
        assert!(list.qualities.contains(&"0.20".to_string()));
        assert!(list.filaments.contains(&"Bambu PLA Basic".to_string()));
        assert!(list.filaments.contains(&"Bambu PETG Basic".to_string()));
    }

    // ── parse_slice_info ──────────────────────────────────────────────

    #[test]
    fn parse_slice_info_extracts_estimates() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="prediction" value="631"/>
    <metadata key="weight" value="3.85"/>
    <filament id="1" type="PLA" used_m="1.29" used_g="3.85"/>
  </plate>
</config>"#;

        let est = super::parse_slice_info_xml(xml).unwrap();
        assert_eq!(est.time_seconds, 631);
        assert!((est.filament_meters - 1.29).abs() < 0.001);
        assert!((est.filament_grams - 3.85).abs() < 0.001);
    }

    #[test]
    fn parse_slice_info_zero_weight() {
        // filament_density unset → used_g is "0.00"
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="prediction" value="420"/>
    <filament id="1" type="PLA" used_m="0.87" used_g="0.00"/>
  </plate>
</config>"#;

        let est = super::parse_slice_info_xml(xml).unwrap();
        assert_eq!(est.time_seconds, 420);
        assert!((est.filament_meters - 0.87).abs() < 0.001);
        assert!((est.filament_grams - 0.0).abs() < 0.001);
    }

    // ── gcode constants ───────────────────────────────────────────────

    #[test]
    fn gcode_constants_match_expected() {
        // Verify character-for-character match with the TS source values
        assert_eq!(
            ORCA_MACHINE_START_GCODE,
            "G28\\nG1 Z5 F5000\\nM104 S[nozzle_temperature_initial_layer]\\nM140 S[bed_temperature_initial_layer_single]\\nM109 S[nozzle_temperature_initial_layer]\\nM190 S[bed_temperature_initial_layer_single]\\nG92 E0\\n"
        );
        assert_eq!(
            ORCA_MACHINE_END_GCODE,
            "G1 E-2 F2400\\nG28 X\\nM104 S0\\nM140 S0\\nM84\\n"
        );
        assert_eq!(
            ORCA_LAYER_CHANGE_GCODE,
            "G92 E0\\n;LAYER_CHANGE\\n;Z:[layer_z]\\nM73 L[layer_num]\\n"
        );
    }

    // ── patch_machine_profile ─────────────────────────────────────────

    #[test]
    fn patch_machine_profile_inlines_includes_and_replaces_gcode() {
        // Create a fake machine profile with includes
        let tmp = TempDir::new().unwrap();
        let machine_dir = tmp.path().join("machine");
        std::fs::create_dir_all(&machine_dir).unwrap();

        // Template file that gets included
        let template = serde_json::json!({
            "name": "should-be-skipped",
            "instantiation": "also-skipped",
            "type": "skipped",
            "from": "skipped",
            "retraction_length": ["0.8"],
            "fan_max_speed": ["100"]
        });
        std::fs::write(
            machine_dir.join("base_template.json"),
            serde_json::to_string(&template).unwrap(),
        )
        .unwrap();

        // Machine profile referencing the template
        let machine = serde_json::json!({
            "name": "Test Machine",
            "include": ["base_template"],
            "machine_start_gcode": "old start gcode",
            "machine_end_gcode": "old end gcode",
            "layer_change_gcode": "old layer gcode"
        });
        let machine_path = machine_dir.join("machine.json");
        std::fs::write(&machine_path, serde_json::to_string(&machine).unwrap()).unwrap();

        let svc = test_service();
        let (_tmp_dir, patched_path) = svc.patch_machine_profile(&machine_path).unwrap();

        let patched: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&patched_path).unwrap()).unwrap();

        // Include was removed
        assert!(patched.get("include").is_none(), "include should be removed");

        // Skipped keys were not copied
        assert_eq!(patched["name"], "Test Machine");

        // Template values were inlined
        assert_eq!(patched["retraction_length"], serde_json::json!(["0.8"]));
        assert_eq!(patched["fan_max_speed"], serde_json::json!(["100"]));

        // Gcode fields were replaced
        assert_eq!(patched["machine_start_gcode"], ORCA_MACHINE_START_GCODE);
        assert_eq!(patched["machine_end_gcode"], ORCA_MACHINE_END_GCODE);
        assert_eq!(patched["layer_change_gcode"], ORCA_LAYER_CHANGE_GCODE);

        // nozzle_volume_type was added
        assert_eq!(
            patched["nozzle_volume_type"],
            serde_json::json!(["0"])
        );
    }

    #[test]
    fn patch_machine_profile_preserves_existing_nozzle_volume_type() {
        let tmp = TempDir::new().unwrap();
        let machine_dir = tmp.path().join("machine");
        std::fs::create_dir_all(&machine_dir).unwrap();

        let machine = serde_json::json!({
            "name": "Test Machine",
            "machine_start_gcode": "old",
            "machine_end_gcode": "old",
            "layer_change_gcode": "old",
            "nozzle_volume_type": ["1"]
        });
        let machine_path = machine_dir.join("machine.json");
        std::fs::write(&machine_path, serde_json::to_string(&machine).unwrap()).unwrap();

        let svc = test_service();
        let (_tmp_dir, patched_path) = svc.patch_machine_profile(&machine_path).unwrap();
        let patched: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&patched_path).unwrap()).unwrap();

        // Existing value should be preserved, not overwritten
        assert_eq!(patched["nozzle_volume_type"], serde_json::json!(["1"]));
    }

    // ── SlicerService ─────────────────────────────────────────────────

    #[test]
    fn default_service_has_expected_paths() {
        let svc = SlicerService::default();
        assert_eq!(svc.orca_cli_path, PathBuf::from(ORCA_CLI));
        assert!(svc.profile_base_path.to_str().unwrap().contains("BambuStudio/system/BBL"));
    }

    // ── Integration test (requires OrcaSlicer installed) ──────────────

    #[test]
    #[ignore]
    fn integration_slice_real_stl() {
        let svc = SlicerService::default();

        // Skip if OrcaSlicer or profiles aren't installed
        if svc.validate().is_err() {
            eprintln!("Skipping integration test: OrcaSlicer or profiles not found");
            return;
        }

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // Create a simple test cube STL (20mm cube)
            let tmp = TempDir::new().unwrap();
            let stl_path = tmp.path().join("test_cube.stl");
            create_test_cube_stl(&stl_path);

            let output_path = tmp.path().join("test_output.3mf");

            let input = SliceInput {
                input_files: vec![stl_path],
                output_file: output_path.clone(),
                quality: "0.20".to_string(),
                filament: "Bambu PLA Basic".to_string(),
            };

            let result = svc.run_slicer(&input).await.expect("slice should succeed");

            assert!(result.success, "slice should succeed");
            assert!(result.output_file.exists(), "3MF output should exist");

            if let Some(est) = &result.estimates {
                assert!(est.time_seconds > 0, "estimated time should be > 0");
                assert!(est.filament_meters > 0.0, "filament used should be > 0");
            } else {
                panic!("estimates should be present");
            }
        });
    }

    /// Create a minimal valid binary STL file (a simple cube).
    #[allow(dead_code)]
    fn create_test_cube_stl(path: &Path) {
        use std::io::Write;

        let mut file = std::fs::File::create(path).unwrap();

        // 80-byte header
        file.write_all(&[0u8; 80]).unwrap();

        // A cube has 12 triangular faces (2 per side × 6 sides)
        let triangles: Vec<([f32; 3], [[f32; 3]; 3])> = vec![
            // Front face (z = 20)
            ([0.0, 0.0, 1.0], [[0.0, 0.0, 20.0], [20.0, 0.0, 20.0], [20.0, 20.0, 20.0]]),
            ([0.0, 0.0, 1.0], [[0.0, 0.0, 20.0], [20.0, 20.0, 20.0], [0.0, 20.0, 20.0]]),
            // Back face (z = 0)
            ([0.0, 0.0, -1.0], [[20.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 20.0, 0.0]]),
            ([0.0, 0.0, -1.0], [[20.0, 0.0, 0.0], [0.0, 20.0, 0.0], [20.0, 20.0, 0.0]]),
            // Right face (x = 20)
            ([1.0, 0.0, 0.0], [[20.0, 0.0, 0.0], [20.0, 0.0, 20.0], [20.0, 20.0, 20.0]]),
            // Correction: we need the second triangle too
            ([1.0, 0.0, 0.0], [[20.0, 0.0, 0.0], [20.0, 20.0, 20.0], [20.0, 20.0, 0.0]]),
            // Left face (x = 0)
            ([-1.0, 0.0, 0.0], [[0.0, 0.0, 20.0], [0.0, 0.0, 0.0], [0.0, 20.0, 0.0]]),
            ([-1.0, 0.0, 0.0], [[0.0, 0.0, 20.0], [0.0, 20.0, 0.0], [0.0, 20.0, 20.0]]),
            // Top face (y = 20)
            ([0.0, 1.0, 0.0], [[0.0, 20.0, 0.0], [20.0, 20.0, 0.0], [20.0, 20.0, 20.0]]),
            ([0.0, 1.0, 0.0], [[0.0, 20.0, 0.0], [20.0, 20.0, 20.0], [0.0, 20.0, 20.0]]),
            // Bottom face (y = 0)
            ([0.0, -1.0, 0.0], [[0.0, 0.0, 20.0], [20.0, 0.0, 20.0], [20.0, 0.0, 0.0]]),
            ([0.0, -1.0, 0.0], [[0.0, 0.0, 20.0], [20.0, 0.0, 0.0], [0.0, 0.0, 0.0]]),
        ];

        // Number of triangles (u32 LE)
        file.write_all(&(triangles.len() as u32).to_le_bytes()).unwrap();

        for (normal, verts) in &triangles {
            // Normal vector (3 × f32)
            for n in normal {
                file.write_all(&n.to_le_bytes()).unwrap();
            }
            // 3 vertices (each 3 × f32)
            for v in verts {
                for c in v {
                    file.write_all(&c.to_le_bytes()).unwrap();
                }
            }
            // Attribute byte count (u16)
            file.write_all(&0u16.to_le_bytes()).unwrap();
        }
    }
}
