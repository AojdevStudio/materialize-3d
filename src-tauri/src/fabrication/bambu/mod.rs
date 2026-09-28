//! Slice a Bambu project 3MF with Bambu Studio's CLI, the way milestone 1 proved works:
//! resolve the project's system presets from the installed profile tree, run the exact
//! proven command, and verify the output against the project's geometry.
//!
//! Flow: [`BambuStudio::locate`] -> [`read_preset_selection`] -> [`resolve_presets`]
//! -> [`slice_project`] -> [`verify`] (with [`part_footprints`]).

mod coverage;
mod gcode;
mod presets;
mod slice;
mod studio;
mod threemf;
mod verify;

#[cfg(test)]
mod integration_tests;

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use gcode::{ExtrusionSegment, ToolFootprint};
pub use presets::{
    resolve_presets, resolve_presets_with_defaults, PresetKind, ResolvedPreset, ResolvedPresets,
    RESOLVER_SCHEMA_VERSION,
};
pub use slice::{slice_project, EffectiveSettings, GcodeFile, PlateWarning, SliceReport};
pub use studio::{BambuStudio, BambuVersion, VALIDATED_VERSIONS};
pub use threemf::{part_footprints, read_preset_selection, PartFootprint, PresetSelection};
pub use verify::{verify, Check, CheckId};

pub type Result<T, E = BambuError> = std::result::Result<T, E>;

/// A JSON object as Bambu profiles and exported settings use it.
pub type JsonMap = serde_json::Map<String, serde_json::Value>;

#[derive(Debug, thiserror::Error)]
pub enum BambuError {
    #[error("{path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("{path}: invalid JSON: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("{path}: {source}")]
    Zip {
        path: PathBuf,
        source: zip::result::ZipError,
    },
    #[error("{path}: {detail}")]
    Model { path: PathBuf, detail: String },
    #[error("no Bambu Studio installation found; searched {}", display_paths(.searched))]
    StudioNotFound { searched: Vec<PathBuf> },
    #[error(
        "no validated Bambu Studio found (validated: {}); found {}",
        VALIDATED_VERSIONS.join(", "),
        .found.join("; ")
    )]
    UnvalidatedStudio { found: Vec<String> },
    #[error("could not determine Bambu Studio version from {exe} --help")]
    VersionUndetected { exe: PathBuf },
    #[error("no Bambu profile directory found next to {exe}")]
    ProfilesNotFound { exe: PathBuf },
    #[error("{0}")]
    Preset(String),
    #[error("{path}: {key} is missing or empty")]
    MissingSelection { path: PathBuf, key: &'static str },
    #[error("input file does not exist: {0}")]
    InputMissing(PathBuf),
    #[error("output directory must be empty to prevent stale slice evidence: {0}")]
    OutputDirNotEmpty(PathBuf),
    #[error("Bambu default probe exited {exit_code:?}: {stderr}")]
    ProbeFailed {
        exit_code: Option<i32>,
        stderr: String,
    },
    #[error("Bambu Studio exited {exit_code:?} without a readable result.json: {detail}")]
    NoResult {
        exit_code: Option<i32>,
        detail: String,
    },
    #[error("slice cancelled")]
    Cancelled,
}

fn display_paths(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Axis-aligned XY bounding box in plate millimetres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bbox {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

impl Bbox {
    fn point(x: f64, y: f64) -> Self {
        Self {
            min_x: x,
            max_x: x,
            min_y: y,
            max_y: y,
        }
    }

    fn include(&mut self, x: f64, y: f64) {
        self.min_x = self.min_x.min(x);
        self.max_x = self.max_x.max(x);
        self.min_y = self.min_y.min(y);
        self.max_y = self.max_y.max(y);
    }

    fn union(&self, other: &Bbox) -> Bbox {
        let mut out = *self;
        out.include(other.min_x, other.min_y);
        out.include(other.max_x, other.max_y);
        out
    }

    /// Largest distance between corresponding edges of the two boxes.
    pub fn max_edge_deviation(&self, other: &Bbox) -> f64 {
        [
            self.min_x - other.min_x,
            self.max_x - other.max_x,
            self.min_y - other.min_y,
            self.max_y - other.max_y,
        ]
        .into_iter()
        .fold(0.0, |acc, d| acc.max(d.abs()))
    }
}

fn io_err(path: &Path) -> impl FnOnce(io::Error) -> BambuError + '_ {
    move |source| BambuError::Io {
        path: path.to_path_buf(),
        source,
    }
}

fn parse_json_object(text: &str, path: &Path) -> Result<JsonMap> {
    match serde_json::from_str(text) {
        Ok(serde_json::Value::Object(map)) => Ok(map),
        Ok(_) => Err(BambuError::Preset(format!(
            "{}: expected a JSON object",
            path.display()
        ))),
        Err(source) => Err(BambuError::Json {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn read_json_object(path: &Path) -> Result<JsonMap> {
    let text = fs::read_to_string(path).map_err(io_err(path))?;
    parse_json_object(&text, path)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path).map_err(io_err(path))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).map_err(io_err(path))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Write via a sibling temp file and rename, so readers never see a partial file.
fn write_atomic(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(io_err(parent))?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let temporary = parent.join(format!(
        "{file_name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let written = File::create(&temporary)
        .and_then(|mut file| file.write_all(data))
        .and_then(|()| fs::rename(&temporary, path));
    written.map_err(|source| {
        // Best effort: the temp file may not exist if create failed.
        let _ = fs::remove_file(&temporary);
        BambuError::Io {
            path: path.to_path_buf(),
            source,
        }
    })
}

/// Matches the wrapper's `JSON.stringify(value, null, 2) + "\n"`.
fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<()> {
    let mut text = serde_json::to_string_pretty(value).map_err(|source| BambuError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    text.push('\n');
    write_atomic(path, text.as_bytes())
}
