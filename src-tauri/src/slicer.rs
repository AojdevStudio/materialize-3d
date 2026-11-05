use std::collections::HashMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tempfile::TempDir;

use crate::fabrication::bambu::{resolve_presets_with_defaults, BambuError, JsonMap, PresetSelection};

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

const MACHINE_PRESET: &str = "Bambu Lab P2S 0.4 nozzle";

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

// ─── Profile Maps ─────────────────────────────────────────────────────────────

/// Maps quality layer-height strings to process preset names in `BBL.json`.
fn process_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("0.08", "0.08mm High Quality @BBL P2S"),
        ("0.12", "0.12mm High Quality @BBL P2S"),
        ("0.16", "0.16mm Standard @BBL P2S"),
        ("0.20", "0.20mm Standard @BBL P2S"),
        ("0.24", "0.24mm Standard @BBL P2S"),
    ])
}

/// Maps filament display names to filament preset names in `BBL.json`.
fn filament_map() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("Bambu PLA Basic", "Bambu PLA Basic @BBL P2S"),
        ("Bambu PLA Matte", "Bambu PLA Matte @BBL P2S"),
        ("Bambu PETG Basic", "Bambu PETG Basic @BBL P2S 0.4 nozzle"),
        ("Generic PLA", "Generic PLA @BBL P2S"),
        ("Generic PETG", "Generic PETG @BBL P2S"),
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

    #[error("slicing completed but OrcaSlicer wrote no 3MF for {path}\nstdout: {stdout}\nstderr: {stderr}")]
    OutputMissing {
        path: String,
        stdout: String,
        stderr: String,
    },

    #[error("failed to parse 3MF: {reason}")]
    ParseError { reason: String },

    #[error("profile patching failed: {reason}")]
    PatchError { reason: String },

    #[error("profile resolution failed: {0}")]
    Preset(#[from] BambuError),

    #[error("OrcaSlicer sliced {sliced} of {expected} input parts")]
    PartsDropped { expected: usize, sliced: usize },

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

/// What `Metadata/slice_info.config` in OrcaSlicer's output 3MF reports.
#[derive(Debug, Clone)]
pub struct SliceInfo {
    pub estimates: SliceEstimates,
    /// `<object>` entries across all plates that OrcaSlicer did not skip.
    pub sliced_parts: usize,
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

    /// Resolve quality + filament names to the P2S system presets they select.
    pub fn preset_selection(quality: &str, filament: &str) -> Result<PresetSelection, SlicerError> {
        let pmap = process_map();
        let fmap = filament_map();

        let process = pmap.get(quality).ok_or_else(|| {
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

        let filament_preset = fmap.get(filament).ok_or_else(|| {
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

        Ok(PresetSelection {
            machine: MACHINE_PRESET.to_string(),
            process: process.to_string(),
            filaments: vec![filament_preset.to_string()],
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

    /// Write a flattened BambuStudio machine preset as an OrcaSlicer-compatible file in `dir`.
    ///
    /// - Replaces the 3 gcode fields with OrcaSlicer-compatible constants
    /// - Adds `nozzle_volume_type` if missing
    pub fn patch_machine_profile(mut profile: JsonMap, dir: &Path) -> Result<PathBuf, SlicerError> {
        profile.insert("machine_start_gcode".into(), ORCA_MACHINE_START_GCODE.into());
        profile.insert("machine_end_gcode".into(), ORCA_MACHINE_END_GCODE.into());
        profile.insert("layer_change_gcode".into(), ORCA_LAYER_CHANGE_GCODE.into());
        profile
            .entry("nozzle_volume_type")
            .or_insert_with(|| serde_json::json!(["0"]));

        let patched_path = dir.join("machine-patched.json");
        let patched_json = serde_json::to_string_pretty(&profile).map_err(|e| SlicerError::PatchError {
            reason: format!("failed to serialize patched profile: {e}"),
        })?;
        std::fs::write(&patched_path, patched_json)?;
        Ok(patched_path)
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
    /// Validates prerequisites, flattens the selected presets' `inherits` chains and
    /// includes, patches the machine preset, runs the CLI subprocess, checks that every
    /// input part was sliced, extracts estimates, and moves the new 3MF to the output path.
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

        let selection = Self::preset_selection(&input.quality, &input.filament)?;

        log::info!(
            "slice start: model={:?}, quality={}, filament={}",
            input.input_files,
            input.quality,
            input.filament
        );

        // The flattened presets live in this run's directory, which drops with it. OrcaSlicer
        // has no compiled-defaults probe, so every include value applies.
        let run_dir = TempDir::new()?;
        let presets = resolve_presets_with_defaults(
            &self.profile_base_path,
            "orcaslicer",
            JsonMap::new(),
            &selection,
            run_dir.path(),
        )?;
        let patched_machine = Self::patch_machine_profile(presets.machine.config, run_dir.path())?;

        // OrcaSlicer exports into a directory this run owns, beside the output, and the 3MF
        // moves into place only once it checks out. An earlier slice's 3MF at the output path
        // can't pass as this one, and a failed slice leaves it untouched.
        let output_dir = output_abs
            .parent()
            .ok_or_else(|| std::io::Error::other(format!("output path {} names no file", output_abs.display())))?;
        let staging = tempfile::Builder::new().prefix(".slice-").tempdir_in(output_dir)?;
        let staged = staging.path().join("out.3mf");

        // Build args with absolute paths
        let args = self.build_slice_args(
            &canonical_inputs,
            &staged,
            &patched_machine,
            &presets.process.path,
            &presets.filaments[0].path,
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
        if !staged.exists() {
            log::error!("slice error: OrcaSlicer wrote no 3MF for {}", output_abs.display());
            return Err(SlicerError::OutputMissing {
                path: output_abs.display().to_string(),
                stdout,
                stderr,
            });
        }

        let SliceInfo { estimates, sliced_parts } = parse_slice_info(&staged)?;
        if sliced_parts != canonical_inputs.len() {
            return Err(SlicerError::PartsDropped {
                expected: canonical_inputs.len(),
                sliced: sliced_parts,
            });
        }
        std::fs::rename(&staged, &output_abs)?;
        log::info!(
            "slice complete: duration={:?}, time_est={}s, filament={:.2}m / {:.1}g",
            start.elapsed(),
            estimates.time_seconds,
            estimates.filament_meters,
            estimates.filament_grams
        );

        Ok(SliceResult {
            success: true,
            output_file: output_abs,
            estimates: Some(estimates),
            error: None,
        })
    }
}

// ─── 3MF Parsing ──────────────────────────────────────────────────────────────

/// Parse `Metadata/slice_info.config` from a 3MF (ZIP) file to extract
/// print time and filament usage estimates and the sliced part count.
pub fn parse_slice_info(path_3mf: &Path) -> Result<SliceInfo, SlicerError> {
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

/// Parse the XML content of `slice_info.config` to extract estimates and sliced parts.
///
/// Expected structure:
/// ```xml
/// <config>
///   <plate>
///     <metadata key="prediction" value="631"/>
///     <object identify_id="7" name="part.stl" skipped="false"/>
///     <filament id="1" type="PLA" used_m="1.29" used_g="0.00"/>
///   </plate>
/// </config>
/// ```
pub fn parse_slice_info_xml(xml: &str) -> Result<SliceInfo, SlicerError> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_str(xml);

    let mut time_seconds: u64 = 0;
    let mut filament_meters: f64 = 0.0;
    let mut filament_grams: f64 = 0.0;
    let mut sliced_parts: usize = 0;

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
                } else if tag_str == "object" {
                    let skipped = e
                        .attributes()
                        .flatten()
                        .any(|attr| attr.key.as_ref() == b"skipped" && attr.value.as_ref() == b"true");
                    if !skipped {
                        sliced_parts += 1;
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

    Ok(SliceInfo {
        estimates: SliceEstimates {
            time_seconds,
            filament_meters,
            filament_grams,
        },
        sliced_parts,
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod tests {
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

    // ── preset_selection ──────────────────────────────────────────────

    #[test]
    fn preset_selection_default() {
        let selection = SlicerService::preset_selection("0.20", "Bambu PLA Basic").unwrap();
        assert_eq!(
            selection,
            PresetSelection {
                machine: "Bambu Lab P2S 0.4 nozzle".to_string(),
                process: "0.20mm Standard @BBL P2S".to_string(),
                filaments: vec!["Bambu PLA Basic @BBL P2S".to_string()],
            }
        );
    }

    #[test]
    fn preset_selection_all_qualities() {
        let expected = vec![
            ("0.08", "0.08mm High Quality @BBL P2S"),
            ("0.12", "0.12mm High Quality @BBL P2S"),
            ("0.16", "0.16mm Standard @BBL P2S"),
            ("0.20", "0.20mm Standard @BBL P2S"),
            ("0.24", "0.24mm Standard @BBL P2S"),
        ];
        for (quality, expected_preset) in expected {
            let selection = SlicerService::preset_selection(quality, "Bambu PLA Basic").unwrap();
            assert_eq!(selection.process, expected_preset, "quality {quality}");
        }
    }

    #[test]
    fn preset_selection_all_filaments() {
        let expected = vec![
            ("Bambu PLA Basic", "Bambu PLA Basic @BBL P2S"),
            ("Bambu PLA Matte", "Bambu PLA Matte @BBL P2S"),
            ("Bambu PETG Basic", "Bambu PETG Basic @BBL P2S 0.4 nozzle"),
            ("Generic PLA", "Generic PLA @BBL P2S"),
            ("Generic PETG", "Generic PETG @BBL P2S"),
        ];
        for (filament, expected_preset) in expected {
            let selection = SlicerService::preset_selection("0.20", filament).unwrap();
            assert_eq!(selection.filaments, vec![expected_preset.to_string()], "filament {filament}");
        }
    }

    #[test]
    fn preset_selection_unknown_quality_errors() {
        let err = SlicerService::preset_selection("0.99", "Bambu PLA Basic").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unknown quality"), "error: {msg}");
        assert!(msg.contains("0.99"), "error should include bad quality: {msg}");
    }

    #[test]
    fn preset_selection_unknown_filament_errors() {
        let err = SlicerService::preset_selection("0.20", "Mystery").unwrap_err();
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

        let est = super::parse_slice_info_xml(xml).unwrap().estimates;
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

        let est = super::parse_slice_info_xml(xml).unwrap().estimates;
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

    fn patched(profile: serde_json::Value) -> serde_json::Value {
        let serde_json::Value::Object(profile) = profile else {
            panic!("machine profile is an object");
        };
        let tmp = TempDir::new().unwrap();
        let patched_path = SlicerService::patch_machine_profile(profile, tmp.path()).unwrap();
        serde_json::from_str(&std::fs::read_to_string(&patched_path).unwrap()).unwrap()
    }

    #[test]
    fn patch_machine_profile_replaces_gcode() {
        let patched = patched(serde_json::json!({
            "name": "Test Machine",
            "retraction_length": ["0.8"],
            "machine_start_gcode": "old start gcode",
            "machine_end_gcode": "old end gcode",
            "layer_change_gcode": "old layer gcode"
        }));

        assert_eq!(patched["name"], "Test Machine");
        assert_eq!(patched["retraction_length"], serde_json::json!(["0.8"]));
        assert_eq!(patched["machine_start_gcode"], ORCA_MACHINE_START_GCODE);
        assert_eq!(patched["machine_end_gcode"], ORCA_MACHINE_END_GCODE);
        assert_eq!(patched["layer_change_gcode"], ORCA_LAYER_CHANGE_GCODE);
        assert_eq!(patched["nozzle_volume_type"], serde_json::json!(["0"]));
    }

    #[test]
    fn patch_machine_profile_preserves_existing_nozzle_volume_type() {
        let patched = patched(serde_json::json!({
            "name": "Test Machine",
            "machine_start_gcode": "old",
            "machine_end_gcode": "old",
            "layer_change_gcode": "old",
            "nozzle_volume_type": ["1"]
        }));

        assert_eq!(patched["nozzle_volume_type"], serde_json::json!(["1"]));
    }

    // ── SlicerService ─────────────────────────────────────────────────

    #[test]
    fn default_service_has_expected_paths() {
        let svc = SlicerService::default();
        assert_eq!(svc.orca_cli_path, PathBuf::from(ORCA_CLI));
        assert!(svc.profile_base_path.to_str().unwrap().contains("BambuStudio/system/BBL"));
    }

    // ── run_slicer against a fake OrcaSlicer ──────────────────────────

    /// A trimmed copy of the real P2S profile chain, laid out like `system/BBL`.
    pub(crate) fn fixture_profiles() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/stl-slicer/profiles/system/BBL")
    }

    /// An OrcaSlicer output 3MF whose one plate lists `sliced` parts, then `skipped` parts
    /// that OrcaSlicer marked `skipped="true"`.
    pub(crate) fn write_sliced_3mf(path: &Path, sliced: usize, skipped: usize) {
        use std::io::Write;

        let parts: String = (1..=sliced + skipped)
            .map(|id| {
                let skipped = id > sliced;
                format!(r#"<object identify_id="{id}" name="part{id}.stl" skipped="{skipped}"/>"#)
            })
            .collect();
        let config = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><config><plate><metadata key="prediction" value="631"/>{parts}<filament id="1" type="PLA" used_m="1.29" used_g="3.85"/></plate></config>"#
        );
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).expect("create 3mf"));
        zip.start_file("Metadata/slice_info.config", zip::write::SimpleFileOptions::default())
            .expect("slice_info entry");
        zip.write_all(config.as_bytes()).expect("write slice_info");
        zip.finish().expect("finish 3mf");
    }

    /// A slice of `parts` input STLs by a fake OrcaSlicer that copies the presets it is handed
    /// into `<dir>/received` and exports `<dir>/sliced.3mf`, which lists `sliced_objects` sliced
    /// parts and `skipped_objects` skipped ones. The fake runs as
    /// `/bin/sh <first STL>`, so the first STL is the script: exec'ing a freshly written file
    /// races other test threads' forks (ETXTBSY).
    fn fake_orca_slice(
        dir: &Path,
        parts: usize,
        sliced_objects: usize,
        skipped_objects: usize,
    ) -> (SlicerService, SliceInput) {
        let received = dir.join("received");
        std::fs::create_dir(&received).expect("received dir");
        let sliced = dir.join("sliced.3mf");
        write_sliced_3mf(&sliced, sliced_objects, skipped_objects);
        let script = format!(
            r#"while [ $# -gt 0 ]; do
  case "$1" in
    --load-settings) machine=${{2%%;*}}; process=${{2#*;}}; shift ;;
    --load-filaments) filament=$2; shift ;;
    --export-3mf) out=$2; shift ;;
  esac
  shift
done
cp "$machine" '{received}/machine.json' && cp "$process" '{received}/process.json' && cp "$filament" '{received}/filament.json' && cp '{sliced}' "$out"
"#,
            received = received.display(),
            sliced = sliced.display()
        );
        let input_files: Vec<PathBuf> = (1..=parts).map(|n| dir.join(format!("part{n}.stl"))).collect();
        std::fs::write(&input_files[0], script).expect("fake OrcaSlicer");
        for stl in &input_files[1..] {
            std::fs::write(stl, "solid part\nendsolid part\n").expect("stl");
        }
        let service = SlicerService {
            orca_cli_path: PathBuf::from("/bin/sh"),
            profile_base_path: fixture_profiles(),
        };
        let input = SliceInput {
            input_files,
            output_file: dir.join("out.3mf"),
            quality: "0.20".to_string(),
            filament: "Bambu PLA Basic".to_string(),
        };
        (service, input)
    }

    fn received_preset(dir: &Path, file: &str) -> serde_json::Value {
        let text = std::fs::read_to_string(dir.join("received").join(file)).expect("preset handed to OrcaSlicer");
        serde_json::from_str(&text).expect("preset JSON")
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn orca_gets_presets_merged_with_their_inherited_parents() {
        let dir = TempDir::new().unwrap();
        let (svc, input) = fake_orca_slice(dir.path(), 1, 1, 0);
        svc.run_slicer(&input).await.expect("slice succeeds");

        let machine = received_preset(dir.path(), "machine.json");
        assert_eq!(machine["gcode_flavor"], "marlin", "set only by fdm_machine_common");
        assert_eq!(machine["extruder_type"], serde_json::json!(["Direct Drive"]), "set only by fdm_bbl_3dp_001_common");
        assert_eq!(machine["extruder_clearance_radius"], "72", "the P2S preset overrides both parents");

        let process = received_preset(dir.path(), "process.json");
        assert_eq!(process["layer_height"], "0.2", "set only by fdm_process_single_0.20");
        assert_eq!(process["travel_speed"], serde_json::json!(["1000", "1000", "1000"]), "the P2S process overrides its parent");

        let filament = received_preset(dir.path(), "filament.json");
        assert_eq!(filament["filament_type"], serde_json::json!(["PLA"]), "set only by Bambu PLA Basic @base");
        assert_eq!(filament["nozzle_temperature"], serde_json::json!(["220", "220", "220"]), "the P2S filament overrides its parent");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_slice_fails_before_orca_runs_when_a_preset_parent_is_missing() {
        let dir = TempDir::new().unwrap();
        let (mut svc, input) = fake_orca_slice(dir.path(), 1, 1, 0);
        let profiles = dir.path().join("profiles");
        let copied = std::process::Command::new("cp")
            .arg("-R")
            .arg(fixture_profiles().parent().expect("system dir"))
            .arg(&profiles)
            .status()
            .expect("cp");
        assert!(copied.success(), "copy the fixture profiles");
        let manifest_path = profiles.join("BBL.json");
        let mut manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
        manifest["filament_list"]
            .as_array_mut()
            .expect("filament_list")
            .retain(|entry| entry["name"] != "Bambu PLA Basic @base");
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        svc.profile_base_path = profiles.join("BBL");

        let err = svc.run_slicer(&input).await.expect_err("the filament parent is gone");
        assert!(matches!(err, SlicerError::Preset(_)), "{err}");
        assert_eq!(std::fs::read_dir(dir.path().join("received")).unwrap().count(), 0, "OrcaSlicer never ran");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn orca_gets_the_p2s_bed_from_the_machine_profile_chain() {
        let dir = TempDir::new().unwrap();
        let (svc, input) = fake_orca_slice(dir.path(), 1, 1, 0);
        svc.run_slicer(&input).await.expect("slice succeeds");

        let machine = received_preset(dir.path(), "machine.json");
        assert_eq!(machine["printable_area"], serde_json::json!(["0x0", "256x0", "256x256", "0x256"]));
        assert_eq!(machine["printable_height"], "256");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_slice_fails_when_orca_drops_an_input_part() {
        let dropped = TempDir::new().unwrap();
        let (svc, input) = fake_orca_slice(dropped.path(), 2, 1, 0);
        let err = svc.run_slicer(&input).await.expect_err("one of two parts was not sliced");
        assert!(err.to_string().contains("sliced 1 of 2 input parts"), "{err}");

        let skipped = TempDir::new().unwrap();
        let (svc, input) = fake_orca_slice(skipped.path(), 2, 1, 1);
        let err = svc.run_slicer(&input).await.expect_err("OrcaSlicer skipped one of two parts");
        assert!(err.to_string().contains("sliced 1 of 2 input parts"), "{err}");

        let unreadable = TempDir::new().unwrap();
        let (svc, input) = fake_orca_slice(unreadable.path(), 1, 1, 0);
        std::fs::write(unreadable.path().join("sliced.3mf"), "OrcaSlicer crashed mid-export").unwrap();
        svc.run_slicer(&input).await.expect_err("the exported 3MF is not a ZIP");

        let complete = TempDir::new().unwrap();
        let (svc, input) = fake_orca_slice(complete.path(), 2, 2, 0);
        svc.run_slicer(&input).await.expect("both parts sliced");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_slice_fails_when_orca_exits_0_without_writing_over_an_earlier_slice() {
        let dir = TempDir::new().unwrap();
        let (svc, input) = fake_orca_slice(dir.path(), 1, 1, 0);
        write_sliced_3mf(&input.output_file, 1, 0);
        let earlier = std::fs::read(&input.output_file).expect("earlier slice");
        std::fs::write(&input.input_files[0], "exit 0\n").expect("OrcaSlicer that writes nothing");

        let err = svc.run_slicer(&input).await.expect_err("the earlier slice is not this one");
        assert!(matches!(err, SlicerError::OutputMissing { .. }), "{err}");
        assert_eq!(std::fs::read(&input.output_file).expect("earlier slice kept"), earlier);
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
