//! What setup and Settings ask about the slicer: the Bambu Studio the slice step would use, the printers it can slice
//! for, and what the person last chose in Bambu Studio.

use serde::Serialize;

use crate::bambu::last_used::{self, LastUsed};
use crate::bambu::{printer_choices, BambuError, BambuStudio, PrinterChoice, VALIDATED_VERSIONS};

/// What setup's check shows for the slicer: the Bambu Studio the slice step would use.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(tag = "found", rename_all = "camelCase")]
pub enum SlicerCheck {
    Ready { version: String },
    None,
    Other { detail: String },
}

/// Looks for the Bambu Studio the slice step uses. Each candidate answers `--help`, which can take seconds, so the
/// search runs off the main thread.
#[tauri::command]
pub async fn studio_slicer() -> Result<SlicerCheck, String> {
    let located = tauri::async_runtime::spawn_blocking(BambuStudio::locate).await.map_err(|e| e.to_string())?;
    Ok(slicer_check(located))
}

fn slicer_check(located: crate::bambu::Result<BambuStudio>) -> SlicerCheck {
    match located {
        Ok(studio) => SlicerCheck::Ready { version: studio.version.to_string() },
        Err(BambuError::StudioNotFound { .. }) => SlicerCheck::None,
        Err(BambuError::UnvalidatedStudio { found }) => SlicerCheck::Other {
            detail: format!(
                "Bambu Studio {} is installed. The app slices with version {}.",
                found.iter().map(|build| build.version.as_ref().map_or("of an unknown version", |v| v.as_str())).collect::<Vec<_>>().join(", "),
                VALIDATED_VERSIONS.join(" or "),
            ),
        },
        Err(other) => SlicerCheck::Other { detail: other.to_string() },
    }
}

/// The printers the validated Bambu Studio can slice for, for the printer step of setup to pick from.
#[tauri::command]
pub async fn studio_printers() -> Result<Vec<PrinterChoice>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let studio = BambuStudio::locate().map_err(|e| e.to_string())?;
        printer_choices(&studio.profiles_dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What Bambu Studio last used on this computer, for the printer step of setup to start from.
#[tauri::command]
pub async fn bambu_last_used() -> Result<Option<LastUsed>, String> {
    let dir = last_used::config_dir().ok_or("this computer has no config folder")?;
    last_used::read(&dir).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn the_slicer_check_says_which_bambu_studio_it_found() {
        let version = |v: &str| serde_json::from_value(serde_json::json!(v)).expect("a version");
        let validated = PathBuf::from("/opt/validated");
        let build = |path: &str, version| crate::bambu::FoundBuild { path: PathBuf::from(path), version };
        let found = [
            Ok(BambuStudio { exe: validated.clone(), profiles_dir: PathBuf::from("/opt/profiles"), version: version("02.08.02.61") }),
            Err(BambuError::StudioNotFound { searched: vec![PathBuf::from("/opt/missing")] }),
            Err(BambuError::UnvalidatedStudio { found: vec![build("/opt/older", Some(version("01.10.00.00")))] }),
            Err(BambuError::UnvalidatedStudio { found: vec![build("/opt/silent", None)] }),
            Err(BambuError::ProfilesNotFound { exe: validated.clone() }),
        ]
        .map(|located| serde_json::to_value(slicer_check(located)).expect("json"));

        let other = |detail: String| serde_json::json!({ "found": "other", "detail": detail });
        assert_eq!(
            found,
            [
                serde_json::json!({ "found": "ready", "version": "02.08.02.61" }),
                serde_json::json!({ "found": "none" }),
                other("Bambu Studio 01.10.00.00 is installed. The app slices with version 02.08.02.61.".to_owned()),
                other("Bambu Studio of an unknown version is installed. The app slices with version 02.08.02.61.".to_owned()),
                other(format!("no Bambu profile directory found next to {}", validated.display())),
            ]
        );
    }
}
