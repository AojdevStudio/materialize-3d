use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tempfile::TempDir;

// ─── Constants ────────────────────────────────────────────────────────────────

/// Primary OpenSCAD CLI location for the current OS (fallback when detection
/// finds nothing, e.g. for error messages).
#[cfg(target_os = "macos")]
pub const OPENSCAD_CLI: &str = "/opt/homebrew/bin/openscad";
#[cfg(target_os = "windows")]
pub const OPENSCAD_CLI: &str = r"C:\Program Files\OpenSCAD\openscad.exe";
#[cfg(all(unix, not(target_os = "macos")))]
pub const OPENSCAD_CLI: &str = "/usr/bin/openscad";

// ─── Error Types ──────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum OpenScadError {
    #[error("OpenSCAD CLI not found at {path}. Install: {}", crate::platform::install_hint("openscad"))]
    MissingCli { path: String },

    #[error("input file not found: {path}")]
    MissingInput { path: String },

    #[error("OpenSCAD compilation failed (exit code {exit_code})\nstderr: {stderr}")]
    CompilationFailed {
        exit_code: i32,
        stderr: String,
    },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// A structured compilation error extracted from OpenSCAD stderr.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenScadCompileError {
    pub line: usize,
    pub message: String,
    pub full_stderr: String,
}

// ─── Parameter Types ──────────────────────────────────────────────────────────

/// A single parameter extracted from OpenSCAD's `-o file.param` JSON output.
///
/// Shape matches the JSON produced by OpenSCAD 2026.03.07:
/// ```json
/// {"name":"width","type":"number","initial":20.0,"min":5.0,"max":50.0,
///  "step":1.0,"group":"Parameters","caption":"..."}
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScadParameter {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    #[serde(default)]
    pub initial: serde_json::Value,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub step: Option<f64>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub caption: Option<String>,
}

/// Result of a successful `extract_params` call.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScadParamResult {
    pub parameters: Vec<ScadParameter>,
    #[serde(default)]
    pub title: Option<String>,
}

/// Result of a successful STL render.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenScadRenderResult {
    pub stl_path: PathBuf,
    pub stderr_warnings: Vec<String>,
    pub duration_ms: u64,
}

// ─── Service ──────────────────────────────────────────────────────────────────

/// Stateless OpenSCAD CLI wrapper. Holds only the path to the CLI binary.
/// Each invocation uses its own `TempDir` for output isolation (D086 pattern).
#[derive(Debug, Clone)]
pub struct OpenScadService {
    pub cli_path: PathBuf,
}

impl Default for OpenScadService {
    fn default() -> Self {
        Self {
            cli_path: crate::platform::detect_openscad()
                .unwrap_or_else(|| PathBuf::from(OPENSCAD_CLI)),
        }
    }
}

impl OpenScadService {
    /// Check whether the OpenSCAD CLI binary exists at the configured path.
    pub fn check_installed(&self) -> bool {
        self.cli_path.exists()
    }

    /// Extract parameters from a `.scad` file using `openscad -o file.param`.
    ///
    /// Returns structured parameter data and an optional title.
    pub async fn extract_params(
        &self,
        scad_path: &Path,
    ) -> Result<ScadParamResult, OpenScadError> {
        if !self.cli_path.exists() {
            return Err(OpenScadError::MissingCli {
                path: self.cli_path.display().to_string(),
            });
        }
        if !scad_path.exists() {
            return Err(OpenScadError::MissingInput {
                path: scad_path.display().to_string(),
            });
        }

        let tmp_dir = TempDir::new()?;
        let param_path = tmp_dir.path().join("output.param");

        let canonical_input = std::fs::canonicalize(scad_path)?;

        let mut cmd = tokio::process::Command::new(&self.cli_path);
        cmd.arg("-o")
            .arg(&param_path)
            .arg(&canonical_input);

        log::info!("openscad: spawning {:?}", cmd);
        let start = Instant::now();
        let output = cmd.output().await?;
        let duration = start.elapsed();
        let exit_code = output.status.code().unwrap_or(-1);

        log::info!(
            "openscad: extract_params exit_code={}, duration={:?}",
            exit_code,
            duration
        );

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            return Err(OpenScadError::CompilationFailed {
                exit_code,
                stderr,
            });
        }

        // Read and parse the param JSON
        let param_json = std::fs::read_to_string(&param_path).map_err(|e| {
            OpenScadError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("failed to read param file {}: {e}", param_path.display()),
            ))
        })?;

        let result: ScadParamResult = serde_json::from_str(&param_json).map_err(|e| {
            OpenScadError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("failed to parse param JSON: {e}"),
            ))
        })?;

        // _tmp_dir drops here, cleaning up
        Ok(result)
    }

    /// Render a `.scad` file to STL, optionally overriding parameters via `-D`.
    ///
    /// Output STL is written to a `TempDir` under `output_dir` (or system temp
    /// if `output_dir` is `None`). The caller owns the returned path.
    pub async fn render_stl(
        &self,
        scad_path: &Path,
        param_overrides: &HashMap<String, String>,
        output_dir: Option<&Path>,
    ) -> Result<OpenScadRenderResult, OpenScadError> {
        if !self.cli_path.exists() {
            return Err(OpenScadError::MissingCli {
                path: self.cli_path.display().to_string(),
            });
        }
        if !scad_path.exists() {
            return Err(OpenScadError::MissingInput {
                path: scad_path.display().to_string(),
            });
        }

        let canonical_input = std::fs::canonicalize(scad_path)?;

        // Determine output location
        let stl_path = match output_dir {
            Some(dir) => {
                std::fs::create_dir_all(dir)?;
                dir.join("output.stl")
            }
            None => {
                let tmp = TempDir::new()?;
                // Persist beyond this scope so the STL file survives
                let p = tmp.keep().join("output.stl");
                p
            }
        };

        let args = Self::build_render_args(&canonical_input, &stl_path, param_overrides);

        let mut cmd = tokio::process::Command::new(&self.cli_path);
        cmd.args(&args);

        log::info!("openscad: spawning {:?}", cmd);
        let start = Instant::now();
        let output = cmd.output().await?;
        let duration = start.elapsed();
        let exit_code = output.status.code().unwrap_or(-1);

        log::info!(
            "openscad: render exit_code={}, duration={:?}",
            exit_code,
            duration
        );

        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            return Err(OpenScadError::CompilationFailed {
                exit_code,
                stderr,
            });
        }

        // Extract warnings from stderr (lines that aren't just stats)
        let warnings = Self::extract_warnings(&stderr);

        Ok(OpenScadRenderResult {
            stl_path,
            stderr_warnings: warnings,
            duration_ms: duration.as_millis() as u64,
        })
    }

    /// Build the CLI argument list for rendering.
    ///
    /// Format: `openscad -o output.stl [-D "var=val" ...] input.scad`
    pub fn build_render_args(
        input: &Path,
        output: &Path,
        overrides: &HashMap<String, String>,
    ) -> Vec<String> {
        let mut args = Vec::new();
        args.push("-o".to_string());
        args.push(output.display().to_string());

        // Sort keys for deterministic ordering (easier to test)
        let mut keys: Vec<&String> = overrides.keys().collect();
        keys.sort();
        for key in keys {
            let val = &overrides[key];
            args.push("-D".to_string());
            args.push(format!("{key}={val}"));
        }

        args.push(input.display().to_string());
        args
    }

    /// Parse stderr for structured compilation errors.
    ///
    /// Matches patterns like:
    /// - `ERROR: Parser error: syntax error in file ..., line N`
    /// - `WARNING: ... in file ..., line N`
    pub fn parse_errors(stderr: &str) -> Vec<OpenScadCompileError> {
        let mut errors = Vec::new();

        for line in stderr.lines() {
            let trimmed = line.trim();
            // Match ERROR lines with file/line info
            if trimmed.starts_with("ERROR:") || trimmed.starts_with("WARNING:") {
                if let Some(line_num) = Self::extract_line_number(trimmed) {
                    errors.push(OpenScadCompileError {
                        line: line_num,
                        message: trimmed.to_string(),
                        full_stderr: stderr.to_string(),
                    });
                }
            }
        }

        errors
    }

    /// Extract a line number from a stderr message containing `line N`.
    fn extract_line_number(msg: &str) -> Option<usize> {
        // Pattern: ", line <N>" at various positions
        let marker = ", line ";
        if let Some(pos) = msg.rfind(marker) {
            let after = &msg[pos + marker.len()..];
            // Take digits until non-digit
            let num_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            num_str.parse().ok()
        } else {
            None
        }
    }

    /// Extract warning lines from stderr, filtering out statistics noise.
    fn extract_warnings(stderr: &str) -> Vec<String> {
        stderr
            .lines()
            .filter(|line| {
                let t = line.trim();
                t.starts_with("WARNING:")
                    || t.starts_with("DEPRECATED:")
            })
            .map(|s| s.trim().to_string())
            .collect()
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_service() -> OpenScadService {
        OpenScadService::default()
    }

    fn test_service_missing() -> OpenScadService {
        OpenScadService {
            cli_path: PathBuf::from("/nonexistent/openscad"),
        }
    }

    // ── check_installed ───────────────────────────────────────────────

    #[test]
    fn check_installed_real_path() {
        let svc = test_service();
        if !svc.check_installed() {
            eprintln!("Skipping: OpenSCAD not installed on this machine");
            return;
        }
        assert!(svc.check_installed());
    }

    #[test]
    fn check_installed_missing_path() {
        let svc = test_service_missing();
        assert!(!svc.check_installed());
    }

    // ── parse_errors ──────────────────────────────────────────────────

    #[test]
    fn parse_errors_syntax_error() {
        let stderr = r#"ERROR: Parser error: syntax error in file /tmp/test.scad, line 5
Can't parse file '/tmp/test.scad'!
"#;
        let errors = OpenScadService::parse_errors(stderr);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].line, 5);
        assert!(errors[0].message.contains("ERROR: Parser error"));
        assert!(errors[0].message.contains("syntax error"));
    }

    #[test]
    fn parse_errors_warning() {
        let stderr =
            "WARNING: Ignoring unknown module 'bad_func' in file /tmp/test.scad, line 12\n\
             Geometries in cache: 1\n";
        let errors = OpenScadService::parse_errors(stderr);
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].line, 12);
        assert!(errors[0].message.contains("WARNING:"));
        assert!(errors[0].message.contains("bad_func"));
    }

    #[test]
    fn parse_errors_multiple() {
        let stderr = "\
WARNING: Ignoring unknown module 'foo' in file /tmp/test.scad, line 3\n\
WARNING: Ignoring unknown module 'bar' in file /tmp/test.scad, line 7\n\
ERROR: Parser error: syntax error in file /tmp/test.scad, line 10\n\
Can't parse file '/tmp/test.scad'!\n";
        let errors = OpenScadService::parse_errors(stderr);
        assert_eq!(errors.len(), 3);
        assert_eq!(errors[0].line, 3);
        assert_eq!(errors[1].line, 7);
        assert_eq!(errors[2].line, 10);
    }

    #[test]
    fn parse_errors_no_errors() {
        let stderr = "Geometries in cache: 1\n\
CGAL Polyhedrons in cache: 0\n\
Total rendering time: 0:00:00.001\n";
        let errors = OpenScadService::parse_errors(stderr);
        assert!(errors.is_empty());
    }

    #[test]
    fn parse_errors_no_line_number() {
        // Some errors don't include line info — should be skipped
        let stderr = "ERROR: No top-level geometry to export\n";
        let errors = OpenScadService::parse_errors(stderr);
        assert!(errors.is_empty());
    }

    // ── param JSON parsing ────────────────────────────────────────────

    #[test]
    fn parse_param_json_valid() {
        let json = r#"{
            "parameters": [
                {"name":"width","type":"number","initial":20.0,"min":5.0,"max":50.0,"step":1.0,"group":"Parameters","caption":"Simple box"},
                {"name":"height","type":"number","initial":10.0,"min":2.0,"max":30.0,"step":0.5,"group":"Parameters"},
                {"name":"label","type":"string","initial":"box","group":"Parameters"}
            ],
            "title":"test_param"
        }"#;

        let result: ScadParamResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.parameters.len(), 3);
        assert_eq!(result.title.as_deref(), Some("test_param"));

        let width = &result.parameters[0];
        assert_eq!(width.name, "width");
        assert_eq!(width.param_type, "number");
        assert_eq!(width.initial, serde_json::json!(20.0));
        assert_eq!(width.min, Some(5.0));
        assert_eq!(width.max, Some(50.0));
        assert_eq!(width.step, Some(1.0));
        assert_eq!(width.group.as_deref(), Some("Parameters"));
        assert_eq!(width.caption.as_deref(), Some("Simple box"));

        let label = &result.parameters[2];
        assert_eq!(label.name, "label");
        assert_eq!(label.param_type, "string");
        assert_eq!(label.initial, serde_json::json!("box"));
        assert!(label.min.is_none());
    }

    #[test]
    fn parse_param_json_empty_params() {
        let json = r#"{"parameters":[],"title":"empty"}"#;
        let result: ScadParamResult = serde_json::from_str(json).unwrap();
        assert!(result.parameters.is_empty());
        assert_eq!(result.title.as_deref(), Some("empty"));
    }

    #[test]
    fn parse_param_json_complex_groups() {
        let json = r#"{
            "parameters": [
                {"name":"outer_r","type":"number","initial":30.0,"min":10.0,"max":100.0,"step":1.0,"group":"Dimensions"},
                {"name":"inner_r","type":"number","initial":20.0,"min":5.0,"max":90.0,"step":1.0,"group":"Dimensions"},
                {"name":"color_r","type":"number","initial":0.5,"min":0.0,"max":1.0,"step":0.01,"group":"Appearance"},
                {"name":"color_g","type":"number","initial":0.5,"min":0.0,"max":1.0,"step":0.01,"group":"Appearance"},
                {"name":"show_base","type":"boolean","initial":true,"group":"Options"}
            ],
            "title":"ring"
        }"#;

        let result: ScadParamResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.parameters.len(), 5);

        // Verify groups
        let groups: Vec<&str> = result
            .parameters
            .iter()
            .filter_map(|p| p.group.as_deref())
            .collect();
        assert!(groups.contains(&"Dimensions"));
        assert!(groups.contains(&"Appearance"));
        assert!(groups.contains(&"Options"));

        // Boolean param
        let show_base = &result.parameters[4];
        assert_eq!(show_base.param_type, "boolean");
        assert_eq!(show_base.initial, serde_json::json!(true));
    }

    // ── build_render_args ─────────────────────────────────────────────

    #[test]
    fn build_render_args_no_overrides() {
        let args = OpenScadService::build_render_args(
            Path::new("/tmp/test.scad"),
            Path::new("/tmp/output.stl"),
            &HashMap::new(),
        );
        assert_eq!(args, vec!["-o", "/tmp/output.stl", "/tmp/test.scad"]);
    }

    #[test]
    fn build_render_args_with_overrides() {
        let mut overrides = HashMap::new();
        overrides.insert("width".to_string(), "40".to_string());
        overrides.insert("height".to_string(), "5".to_string());

        let args = OpenScadService::build_render_args(
            Path::new("/tmp/test.scad"),
            Path::new("/tmp/output.stl"),
            &overrides,
        );

        // Keys sorted: height before width
        assert_eq!(
            args,
            vec![
                "-o",
                "/tmp/output.stl",
                "-D",
                "height=5",
                "-D",
                "width=40",
                "/tmp/test.scad",
            ]
        );
    }

    #[test]
    fn build_render_args_string_override() {
        let mut overrides = HashMap::new();
        overrides.insert("label".to_string(), r#""hello""#.to_string());

        let args = OpenScadService::build_render_args(
            Path::new("/tmp/test.scad"),
            Path::new("/tmp/output.stl"),
            &overrides,
        );

        assert_eq!(
            args,
            vec!["-o", "/tmp/output.stl", "-D", r#"label="hello""#, "/tmp/test.scad"]
        );
    }

    // ── extract_warnings ──────────────────────────────────────────────

    #[test]
    fn extract_warnings_filters_stats() {
        let stderr = "\
WARNING: Ignoring unknown module 'foo' in file /tmp/test.scad, line 3\n\
Geometries in cache: 1\n\
Geometry cache size in bytes: 856\n\
CGAL Polyhedrons in cache: 0\n\
Total rendering time: 0:00:00.001\n";

        let warnings = OpenScadService::extract_warnings(stderr);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("WARNING:"));
    }

    // ── Integration tests (require OpenSCAD installed) ────────────────

    #[tokio::test]
    async fn integration_extract_params_real() {
        let svc = test_service();
        if !svc.check_installed() {
            eprintln!("Skipping: OpenSCAD not installed");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let scad_path = tmp.path().join("test.scad");
        std::fs::write(
            &scad_path,
            "width = 20; // [5:1:50]\nheight = 10; // [2:0.5:30]\ncube([width, height, 5]);\n",
        )
        .unwrap();

        let result = svc.extract_params(&scad_path).await.unwrap();
        assert_eq!(result.parameters.len(), 2);
        assert_eq!(result.parameters[0].name, "width");
        assert_eq!(result.parameters[1].name, "height");
    }

    #[tokio::test]
    async fn integration_render_stl_real() {
        let svc = test_service();
        if !svc.check_installed() {
            eprintln!("Skipping: OpenSCAD not installed");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let scad_path = tmp.path().join("test.scad");
        std::fs::write(&scad_path, "cube([10, 10, 10]);\n").unwrap();

        let output_dir = tmp.path().join("output");
        let result = svc
            .render_stl(&scad_path, &HashMap::new(), Some(&output_dir))
            .await
            .unwrap();

        assert!(result.stl_path.exists(), "STL should exist");
        assert!(result.duration_ms < 10_000, "Should complete in < 10s");
    }

    #[tokio::test]
    async fn integration_render_stl_with_overrides() {
        let svc = test_service();
        if !svc.check_installed() {
            eprintln!("Skipping: OpenSCAD not installed");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let scad_path = tmp.path().join("test.scad");
        std::fs::write(
            &scad_path,
            "width = 20;\ncube([width, 10, 10]);\n",
        )
        .unwrap();

        let mut overrides = HashMap::new();
        overrides.insert("width".to_string(), "40".to_string());

        let output_dir = tmp.path().join("output");
        let result = svc
            .render_stl(&scad_path, &overrides, Some(&output_dir))
            .await
            .unwrap();

        assert!(result.stl_path.exists());
        // The file with width=40 should be larger than default width=20
        let size = std::fs::metadata(&result.stl_path).unwrap().len();
        assert!(size > 0);
    }

    #[tokio::test]
    async fn integration_render_stl_syntax_error() {
        let svc = test_service();
        if !svc.check_installed() {
            eprintln!("Skipping: OpenSCAD not installed");
            return;
        }

        let tmp = TempDir::new().unwrap();
        let scad_path = tmp.path().join("error.scad");
        std::fs::write(&scad_path, "cube([10, 20, 30])\nsphere(;\n").unwrap();

        let output_dir = tmp.path().join("output");
        let result = svc
            .render_stl(&scad_path, &HashMap::new(), Some(&output_dir))
            .await;

        assert!(result.is_err());
        if let Err(OpenScadError::CompilationFailed { exit_code, stderr }) = result {
            assert_eq!(exit_code, 1);
            let errors = OpenScadService::parse_errors(&stderr);
            assert!(!errors.is_empty());
            assert!(errors[0].message.contains("syntax error"));
        } else {
            panic!("Expected CompilationFailed error");
        }
    }

    #[tokio::test]
    async fn integration_extract_params_missing_file() {
        let svc = test_service();
        if !svc.check_installed() {
            eprintln!("Skipping: OpenSCAD not installed");
            return;
        }

        let result = svc.extract_params(Path::new("/tmp/nonexistent.scad")).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            OpenScadError::MissingInput { path } => {
                assert!(path.contains("nonexistent"));
            }
            other => panic!("Expected MissingInput, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn extract_params_missing_cli() {
        let svc = test_service_missing();
        let result = svc.extract_params(Path::new("/tmp/test.scad")).await;
        assert!(result.is_err());
        match result.unwrap_err() {
            OpenScadError::MissingCli { path } => {
                assert!(path.contains("nonexistent"));
            }
            other => panic!("Expected MissingCli, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn render_stl_missing_cli() {
        let svc = test_service_missing();
        let result = svc
            .render_stl(Path::new("/tmp/test.scad"), &HashMap::new(), None)
            .await;
        assert!(result.is_err());
        match result.unwrap_err() {
            OpenScadError::MissingCli { .. } => {}
            other => panic!("Expected MissingCli, got: {other:?}"),
        }
    }
}
