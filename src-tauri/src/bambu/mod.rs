//! The validated Bambu Studio and its system presets, for the agent's slice step
//! (`crate::studio::slice`): [`BambuStudio::locate`] finds the build, and
//! [`resolve_presets`] flattens the named presets into files its CLI loads.

mod presets;
mod studio;

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub use presets::resolve_presets;
pub use studio::{BambuStudio, FoundBuild, VALIDATED_VERSIONS};

pub type Result<T, E = BambuError> = std::result::Result<T, E>;

/// A JSON object as Bambu profiles and exported settings use it.
pub type JsonMap = serde_json::Map<String, serde_json::Value>;

/// System preset names to slice with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetSelection {
    pub machine: String,
    pub process: String,
    /// One per filament slot, in slot order; duplicates are expected.
    pub filaments: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BambuError {
    #[error("{path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("{path}: invalid JSON: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("no Bambu Studio installation found; searched {}", display_paths(.searched))]
    StudioNotFound { searched: Vec<PathBuf> },
    #[error(
        "no validated Bambu Studio found (validated: {}); found {}",
        VALIDATED_VERSIONS.join(", "),
        join_display(.found)
    )]
    UnvalidatedStudio { found: Vec<FoundBuild> },
    #[error("could not determine Bambu Studio version from {exe} --help")]
    VersionUndetected { exe: PathBuf },
    #[error("Bambu Studio did not answer its version check. macOS may be asking about it. Open Bambu Studio once from Applications, then try again.")]
    VersionCheckTimedOut { exe: PathBuf },
    #[error("no Bambu profile directory found next to {exe}")]
    ProfilesNotFound { exe: PathBuf },
    #[error("{0}")]
    Preset(String),
    #[error("Bambu default probe exited {exit_code:?}: {stderr}")]
    ProbeFailed {
        exit_code: Option<i32>,
        stderr: String,
    },
}

fn join_display(items: &[impl std::fmt::Display]) -> String {
    items
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

fn display_paths(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
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
