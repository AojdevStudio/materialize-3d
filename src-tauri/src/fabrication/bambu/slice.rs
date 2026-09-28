use std::ffi::OsString;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    gcode, io_err, read_json_object, sha256_file, BambuError, BambuStudio, JsonMap,
    ResolvedPresets, Result, ToolFootprint,
};

const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Everything a slice run produced that verification and the revision store need.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceReport {
    pub out_dir: PathBuf,
    /// Process exit code; `None` when the process ended by signal.
    pub exit_code: Option<i32>,
    pub return_code: i64,
    pub error_string: String,
    pub plate_warnings: Vec<PlateWarning>,
    /// `None` when Bambu did not export effective settings.
    pub effective: Option<EffectiveSettings>,
    /// `plate_N.gcode` files in plate order.
    pub gcode: Vec<GcodeFile>,
    pub input_sha256_before: String,
    pub input_sha256_after: String,
    /// Per-tool first-layer extrusion from `plate_1.gcode`.
    pub layer1: Vec<ToolFootprint>,
    pub stdout_log: PathBuf,
    pub stderr_log: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlateWarning {
    pub plate_id: u32,
    /// Empty when the plate sliced without a warning.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GcodeFile {
    pub path: PathBuf,
    pub sha256: String,
}

/// The settings Bambu actually sliced with, from `--export-settings`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectiveSettings {
    pub printer_settings_id: String,
    pub print_settings_id: String,
    pub filament_settings_id: Vec<String>,
    pub filament_colour: Vec<String>,
    pub nozzle_diameter: Vec<String>,
    pub printable_area: Vec<String>,
    pub layer_height: String,
    pub enable_prime_tower: bool,
    /// Effective `machine_start_gcode` equals the resolved machine preset's.
    pub start_gcode_matches_preset: bool,
    /// Every plate G-code's config header carries the preset's start G-code, serialized.
    pub start_gcode_in_gcode_header: bool,
}

/// `result.json` fields this module reads.
#[derive(Deserialize)]
struct SliceResult {
    return_code: i64,
    #[serde(default)]
    error_string: String,
    #[serde(default)]
    sliced_plates: Vec<SlicedPlate>,
}

#[derive(Deserialize)]
struct SlicedPlate {
    id: u32,
    #[serde(default)]
    warning_message: String,
}

/// Slices a project 3MF with the resolved presets using the proven command:
///
/// `<bambu> <input> --load-settings "<process>;<machine>" --load-filaments "<f1>;...;<fN>"
///  --check-preset --arrange 0 --slice 0 --export-settings <out>/effective-settings.json
///  --outputdir <out>`
///
/// No orient, no arrange, no filament or start-G-code overrides: the project's placement
/// and colour assignment must survive untouched. `out_dir` must be absent or empty. The
/// input is hashed before and after. `is_cancelled` is polled while Bambu runs; returning
/// true kills the child and yields [`BambuError::Cancelled`].
pub fn slice_project(
    studio: &BambuStudio,
    presets: &ResolvedPresets,
    input: &Path,
    out_dir: &Path,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<SliceReport> {
    let input = std::path::absolute(input).map_err(io_err(input))?;
    if !input.is_file() {
        return Err(BambuError::InputMissing(input));
    }
    let out_dir = std::path::absolute(out_dir).map_err(io_err(out_dir))?;
    prepare_empty_dir(&out_dir)?;

    let input_sha256_before = sha256_file(&input)?;
    let effective_path = out_dir.join("effective-settings.json");
    let stdout_log = out_dir.join("bambu-stdout.log");
    let stderr_log = out_dir.join("bambu-stderr.log");

    let load_settings = join_semicolon([&presets.process.path, &presets.machine.path]);
    let load_filaments = join_semicolon(presets.filaments.iter().map(|f| &f.path));

    let mut child = Command::new(&studio.exe)
        .arg(&input)
        .arg("--load-settings")
        .arg(load_settings)
        .arg("--load-filaments")
        .arg(load_filaments)
        .args([
            "--check-preset",
            "--arrange",
            "0",
            "--slice",
            "0",
            "--export-settings",
        ])
        .arg(&effective_path)
        .arg("--outputdir")
        .arg(&out_dir)
        // Bambu also writes result.json into its working directory; an installed
        // app's working directory is not writable, and a checkout would collect strays.
        .current_dir(&out_dir)
        .stdin(Stdio::null())
        .stdout(File::create(&stdout_log).map_err(io_err(&stdout_log))?)
        .stderr(File::create(&stderr_log).map_err(io_err(&stderr_log))?)
        .spawn()
        .map_err(io_err(&studio.exe))?;

    let status = loop {
        if let Some(status) = child.try_wait().map_err(io_err(&studio.exe))? {
            break status;
        }
        if is_cancelled() {
            // kill fails only if the child already exited; wait reaps it either way.
            let _ = child.kill();
            child.wait().map_err(io_err(&studio.exe))?;
            return Err(BambuError::Cancelled);
        }
        thread::sleep(POLL_INTERVAL);
    };
    let exit_code = status.code();
    let input_sha256_after = sha256_file(&input)?;

    let result_path = out_dir.join("result.json");
    let result: SliceResult = fs::read_to_string(&result_path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|e| e.to_string()))
        .map_err(|detail| {
            let stderr = fs::read_to_string(&stderr_log).unwrap_or_default();
            BambuError::NoResult {
                exit_code,
                detail: format!("{detail}; stderr: {}", stderr.trim()),
            }
        })?;

    let mut gcode = Vec::new();
    let mut layer1 = Vec::new();
    let mut headers_match = true;
    let expected_header = presets
        .machine
        .config
        .get("machine_start_gcode")
        .and_then(Value::as_str)
        .map(serialize_header_value);
    for (plate, path) in plate_gcode_files(&out_dir)? {
        let file = File::open(&path).map_err(io_err(&path))?;
        let scan = gcode::scan(BufReader::new(file)).map_err(io_err(&path))?;
        headers_match &= expected_header.is_some() && scan.machine_start_gcode == expected_header;
        if plate == 1 {
            layer1 = scan.layer1;
        }
        gcode.push(GcodeFile {
            path,
            sha256: scan.sha256,
        });
    }

    let effective = if effective_path.is_file() {
        let settings = read_json_object(&effective_path)?;
        Some(summarize_effective(
            &settings,
            &effective_path,
            presets,
            headers_match && !gcode.is_empty(),
        )?)
    } else {
        None
    };

    Ok(SliceReport {
        out_dir,
        exit_code,
        return_code: result.return_code,
        error_string: result.error_string,
        plate_warnings: result
            .sliced_plates
            .into_iter()
            .map(|p| PlateWarning {
                plate_id: p.id,
                message: p.warning_message,
            })
            .collect(),
        effective,
        gcode,
        input_sha256_before,
        input_sha256_after,
        layer1,
        stdout_log,
        stderr_log,
    })
}

/// Bambu splits path lists on ';' on every platform.
fn join_semicolon<'a>(paths: impl IntoIterator<Item = &'a PathBuf>) -> OsString {
    let mut joined = OsString::new();
    for (index, path) in paths.into_iter().enumerate() {
        if index > 0 {
            joined.push(";");
        }
        joined.push(path);
    }
    joined
}

fn prepare_empty_dir(dir: &Path) -> Result<()> {
    match fs::read_dir(dir) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(BambuError::OutputDirNotEmpty(dir.to_path_buf()));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dir).map_err(io_err(dir))
        }
        Err(e) => Err(io_err(dir)(e)),
    }
}

/// `plate_<n>.gcode` files sorted by plate number.
fn plate_gcode_files(dir: &Path) -> Result<Vec<(u32, PathBuf)>> {
    let mut plates: Vec<(u32, PathBuf)> = fs::read_dir(dir)
        .map_err(io_err(dir))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name();
            let plate = name
                .to_str()?
                .strip_prefix("plate_")?
                .strip_suffix(".gcode")?
                .parse()
                .ok()?;
            Some((plate, entry.path()))
        })
        .collect();
    plates.sort();
    Ok(plates)
}

/// Bambu writes config values into the G-code header JSON-escaped without the quotes
/// (the wrapper's `JSON.stringify(value).slice(1, -1)`).
fn serialize_header_value(value: &str) -> String {
    let quoted = Value::from(value).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

fn summarize_effective(
    settings: &JsonMap,
    path: &Path,
    presets: &ResolvedPresets,
    start_gcode_in_gcode_header: bool,
) -> Result<EffectiveSettings> {
    let bad = |key: &str| BambuError::Model {
        path: path.to_path_buf(),
        detail: format!("{key} is missing or malformed"),
    };
    let string = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| bad(key))
    };
    let list = |key: &str| {
        settings
            .get(key)
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| bad(key))
    };
    let enable_prime_tower = match string("enable_prime_tower")?.as_str() {
        "0" => false,
        "1" => true,
        _ => return Err(bad("enable_prime_tower")),
    };
    let start_gcode_matches_preset = settings.get("machine_start_gcode").is_some()
        && settings.get("machine_start_gcode") == presets.machine.config.get("machine_start_gcode");
    Ok(EffectiveSettings {
        printer_settings_id: string("printer_settings_id")?,
        print_settings_id: string("print_settings_id")?,
        filament_settings_id: list("filament_settings_id")?,
        filament_colour: list("filament_colour")?,
        nozzle_diameter: list("nozzle_diameter")?,
        printable_area: list("printable_area")?,
        layer_height: string("layer_height")?,
        enable_prime_tower,
        start_gcode_matches_preset,
        start_gcode_in_gcode_header,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::fabrication::bambu::{BambuVersion, ResolvedPreset};
    use std::cell::Cell;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    fn preset(dir: &Path, name: &str) -> ResolvedPreset {
        ResolvedPreset {
            name: name.into(),
            path: dir.join(format!("{name}.json")),
            source_path: dir.join(name),
            config: JsonMap::new(),
        }
    }

    fn fixture(dir: &Path, script: &str) -> (BambuStudio, ResolvedPresets, PathBuf) {
        let exe = dir.join("fake-bambu");
        fs::write(&exe, format!("#!/bin/sh\n{script}\n")).expect("script");
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).expect("chmod");
        let input = dir.join("input.3mf");
        fs::write(&input, b"project").expect("input");
        let studio = BambuStudio {
            exe,
            profiles_dir: dir.to_path_buf(),
            version: BambuVersion("02.08.02.61".into()),
        };
        let presets = ResolvedPresets {
            app_version: "02.08.02.61".into(),
            cache_dir: dir.to_path_buf(),
            filaments: vec![preset(dir, "f")],
            machine: preset(dir, "m"),
            process: preset(dir, "p"),
            profile_manifest: dir.join("BBL.json"),
            profile_version: "1".into(),
            resolver_schema_version: 2,
        };
        (studio, presets, input)
    }

    #[test]
    fn bambu_writes_its_working_directory_files_into_the_output_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = r#"for last; do :; done
echo '{"return_code": 0, "sliced_plates": []}' > "$last/result.json"
echo stray > stray-from-bambu"#;
        let (studio, presets, input) = fixture(dir.path(), script);
        let out = dir.path().join("out");
        slice_project(&studio, &presets, &input, &out, &|| false).expect("report");
        assert!(out.join("stray-from-bambu").is_file(), "Bambu ran inside the output directory");
        assert!(!std::path::Path::new("stray-from-bambu").exists(), "nothing landed in the caller's directory");
    }

    #[test]
    fn refuses_a_non_empty_output_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (studio, presets, input) = fixture(dir.path(), "exit 0");
        let out = dir.path().join("out");
        fs::create_dir(&out).expect("mkdir");
        fs::write(out.join("stale.gcode"), "stale").expect("stale");
        let err = slice_project(&studio, &presets, &input, &out, &|| false).expect_err("non-empty");
        assert!(matches!(err, BambuError::OutputDirNotEmpty(_)), "{err}");
    }

    #[test]
    fn cancellation_kills_the_running_slicer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("finished");
        let (studio, presets, input) = fixture(
            dir.path(),
            &format!("sleep 30\ntouch '{}'", marker.display()),
        );
        let polls = Cell::new(0);
        let started = Instant::now();
        let err = slice_project(&studio, &presets, &input, &dir.path().join("out"), &|| {
            polls.set(polls.get() + 1);
            polls.get() > 2
        })
        .expect_err("cancelled");
        assert!(matches!(err, BambuError::Cancelled), "{err}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "returned promptly"
        );
        assert!(!marker.exists(), "child did not run to completion");
    }

    #[test]
    fn reports_a_rejected_slice_without_failing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = r#"for last; do :; done
echo '{"return_code": -50, "error_string": "Rejected", "sliced_plates": [{"id": 1, "warning_message": "floating"}]}' > "$last/result.json""#;
        let (studio, presets, input) = fixture(dir.path(), script);
        let report = slice_project(&studio, &presets, &input, &dir.path().join("out"), &|| {
            false
        })
        .expect("report");
        assert_eq!(report.return_code, -50);
        assert_eq!(
            report.plate_warnings,
            vec![PlateWarning {
                plate_id: 1,
                message: "floating".into()
            }]
        );
        assert!(report.effective.is_none());
        assert_eq!(report.input_sha256_before, report.input_sha256_after);
    }
}
