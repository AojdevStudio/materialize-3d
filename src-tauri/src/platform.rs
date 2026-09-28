//! Cross-platform resolution of external CLI tools and profile directories.
//!
//! Everything the app shells out to (OrcaSlicer, OpenSCAD) or reads from disk
//! (BambuStudio/OrcaSlicer system profiles) is located here so the rest of the
//! codebase stays platform-agnostic. Each tool can be overridden with an
//! environment variable, then standard per-OS install locations are probed,
//! then PATH is searched.

use std::path::PathBuf;

// ─── Generic helpers ──────────────────────────────────────────────────────────

/// Search PATH for an executable by name (`.exe` appended on Windows).
pub fn find_on_path(exe_name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{exe_name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

/// Return the env override if set and pointing at an existing file.
fn env_override(var: &str) -> Option<PathBuf> {
    std::env::var(var).ok().map(PathBuf::from).filter(|p| p.is_file())
}

/// First existing path from a candidate list.
fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| p.is_file()).cloned()
}

/// Per-OS install instructions for error messages.
pub fn install_hint(tool: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        match tool {
            "orcaslicer" => "brew install --cask orcaslicer".to_string(),
            "openscad" => "brew install openscad".to_string(),
            _ => format!("install {tool}"),
        }
    }
    #[cfg(target_os = "windows")]
    {
        match tool {
            "orcaslicer" => {
                "download from https://github.com/SoftFever/OrcaSlicer/releases".to_string()
            }
            "openscad" => "download from https://openscad.org/downloads.html".to_string(),
            _ => format!("install {tool}"),
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match tool {
            "orcaslicer" => {
                "download the AppImage from https://github.com/SoftFever/OrcaSlicer/releases"
                    .to_string()
            }
            "openscad" => "install via your package manager, e.g. apt install openscad".to_string(),
            _ => format!("install {tool}"),
        }
    }
}

// ─── OrcaSlicer ───────────────────────────────────────────────────────────────

/// Environment variable that overrides OrcaSlicer CLI detection.
pub const ORCA_SLICER_CLI_ENV: &str = "ORCA_SLICER_CLI";

/// Locate the OrcaSlicer CLI binary.
///
/// Order: `ORCA_SLICER_CLI` env override → standard per-OS install paths → PATH.
pub fn detect_orca_slicer() -> Option<PathBuf> {
    if let Some(p) = env_override(ORCA_SLICER_CLI_ENV) {
        return Some(p);
    }

    #[cfg(target_os = "macos")]
    let candidates = vec![PathBuf::from(
        "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
    )];

    #[cfg(target_os = "windows")]
    let candidates = vec![PathBuf::from(r"C:\Program Files\OrcaSlicer\orca-slicer.exe")];

    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates = vec![
        PathBuf::from("/usr/bin/orca-slicer"),
        PathBuf::from("/usr/local/bin/orca-slicer"),
        PathBuf::from("/snap/bin/orca-slicer"),
    ];

    first_existing(&candidates)
        .or_else(|| find_on_path("orca-slicer"))
        .or_else(|| find_on_path("OrcaSlicer"))
}

// ─── OpenSCAD ─────────────────────────────────────────────────────────────────

/// Environment variable that overrides OpenSCAD CLI detection.
pub const OPENSCAD_CLI_ENV: &str = "OPENSCAD_CLI";

/// Locate the OpenSCAD CLI binary.
///
/// Order: `OPENSCAD_CLI` env override → standard per-OS install paths → PATH.
pub fn detect_openscad() -> Option<PathBuf> {
    if let Some(p) = env_override(OPENSCAD_CLI_ENV) {
        return Some(p);
    }

    #[cfg(target_os = "macos")]
    let candidates = vec![
        PathBuf::from("/opt/homebrew/bin/openscad"),
        PathBuf::from("/usr/local/bin/openscad"),
        PathBuf::from("/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"),
    ];

    #[cfg(target_os = "windows")]
    let candidates = vec![PathBuf::from(r"C:\Program Files\OpenSCAD\openscad.exe")];

    #[cfg(all(unix, not(target_os = "macos")))]
    let candidates = vec![
        PathBuf::from("/usr/bin/openscad"),
        PathBuf::from("/usr/local/bin/openscad"),
    ];

    first_existing(&candidates).or_else(|| find_on_path("openscad"))
}

// ─── BambuStudio / OrcaSlicer profiles ───────────────────────────────────────

/// Base directory containing Bambu system profiles (`system/BBL`).
///
/// Reads BambuStudio's profile store when present, falling back to
/// OrcaSlicer's, since either provides the BBL system profiles we patch.
pub fn bambu_profile_base() -> Option<PathBuf> {
    let base = if cfg!(target_os = "macos") {
        dirs::home_dir()?.join("Library/Application Support")
    } else if cfg!(windows) {
        dirs::config_dir()? // %APPDATA%
    } else {
        dirs::config_dir()? // ~/.config
    };

    for app in ["BambuStudio", "OrcaSlicer"] {
        let candidate = base.join(app).join("system").join("BBL");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    // Default to the BambuStudio location even when missing, so error
    // messages point at a meaningful path.
    Some(base.join("BambuStudio").join("system").join("BBL"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_when_pointing_at_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("fake-orca");
        std::fs::write(&fake, b"#!/bin/sh\n").unwrap();
        std::env::set_var(ORCA_SLICER_CLI_ENV, &fake);
        assert_eq!(detect_orca_slicer(), Some(fake));
        std::env::remove_var(ORCA_SLICER_CLI_ENV);
    }

    #[test]
    fn env_override_ignored_when_missing() {
        std::env::set_var(OPENSCAD_CLI_ENV, "/definitely/not/here/openscad");
        // Falls through to candidate/PATH probing — must not return the bogus path.
        let result = detect_openscad();
        assert_ne!(result, Some(PathBuf::from("/definitely/not/here/openscad")));
        std::env::remove_var(OPENSCAD_CLI_ENV);
    }

    #[test]
    fn profile_base_is_absolute() {
        let base = bambu_profile_base().unwrap();
        assert!(base.is_absolute());
        assert!(base.ends_with("BBL"));
    }
}
