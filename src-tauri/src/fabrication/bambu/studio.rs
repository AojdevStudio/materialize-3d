use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::{BambuError, Result};

/// Bambu Studio builds whose CLI slicing has been proven end to end.
pub const VALIDATED_VERSIONS: &[&str] = &["02.08.02.61"];

/// Version string reported by `BambuStudio --help`, e.g. `02.08.02.61`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BambuVersion(pub(super) String);

impl BambuVersion {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_validated(&self) -> bool {
        VALIDATED_VERSIONS.contains(&self.0.as_str())
    }

    /// Extracts the version the way the reference wrapper does: `BambuStudio-([^:\s]+)`.
    fn from_help(output: &str) -> Option<Self> {
        let (_, rest) = output.split_once("BambuStudio-")?;
        let end = rest
            .find(|c: char| c == ':' || c.is_whitespace())
            .unwrap_or(rest.len());
        (end > 0).then(|| Self(rest[..end].to_owned()))
    }
}

impl fmt::Display for BambuVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A located Bambu Studio executable and the `BBL` vendor profile directory it ships.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BambuStudio {
    pub exe: PathBuf,
    pub profiles_dir: PathBuf,
    pub version: BambuVersion,
}

/// An executable found on disk, before its version is known.
struct Candidate {
    exe: PathBuf,
    profiles_dir: Option<PathBuf>,
}

/// An executable whose `--help` has been read.
struct Probed {
    exe: PathBuf,
    profiles_dir: Option<PathBuf>,
    version: Option<BambuVersion>,
}

impl BambuStudio {
    /// Finds a validated Bambu Studio.
    ///
    /// `BAMBU_STUDIO_CLI` (with optional `BAMBU_STUDIO_PROFILES`) is an explicit choice and is
    /// the only candidate when set. Otherwise the platform install locations are searched in
    /// order and the first validated build wins over any earlier unvalidated one. There is no
    /// fallback to an unvalidated build.
    pub fn locate() -> Result<Self> {
        let candidates = match env::var_os("BAMBU_STUDIO_CLI") {
            Some(exe) => {
                let exe = PathBuf::from(exe);
                if !exe.is_file() {
                    return Err(BambuError::StudioNotFound {
                        searched: vec![exe],
                    });
                }
                let profiles_dir = env::var_os("BAMBU_STUDIO_PROFILES").map(PathBuf::from);
                vec![Candidate { exe, profiles_dir }]
            }
            None => discover_candidates(),
        };
        if candidates.is_empty() {
            return Err(BambuError::StudioNotFound {
                searched: search_roots(),
            });
        }
        let probed = candidates
            .into_iter()
            .map(|c| Probed {
                version: detect_version(&c.exe),
                exe: c.exe,
                profiles_dir: c.profiles_dir,
            })
            .collect();
        select(probed)
    }
}

fn detect_version(exe: &Path) -> Option<BambuVersion> {
    let output = Command::new(exe).arg("--help").output().ok()?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    BambuVersion::from_help(&text)
}

/// Picks the first validated candidate, or explains what was found instead.
fn select(mut probed: Vec<Probed>) -> Result<BambuStudio> {
    let chosen = probed
        .iter()
        .position(|p| p.version.as_ref().is_some_and(BambuVersion::is_validated));
    let Some(index) = chosen else {
        let found = probed
            .iter()
            .map(|p| {
                let version = p
                    .version
                    .as_ref()
                    .map_or("unknown version", BambuVersion::as_str);
                format!("{} ({version})", p.exe.display())
            })
            .collect();
        return Err(BambuError::UnvalidatedStudio { found });
    };
    let Probed {
        exe,
        profiles_dir,
        version,
    } = probed.swap_remove(index);
    let version = version.ok_or(BambuError::VersionUndetected { exe: exe.clone() })?;
    let profiles_dir = match profiles_dir {
        Some(dir) => dir,
        None => derive_profiles_dir(&exe)
            .ok_or_else(|| BambuError::ProfilesNotFound { exe: exe.clone() })?,
    };
    Ok(BambuStudio {
        exe,
        profiles_dir,
        version,
    })
}

fn search_roots() -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/Applications/BambuStudio.app"),
            home.join("Applications/BambuStudio.app"),
            home.join("Applications/*/BambuStudio.app"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/bin/bambu-studio"),
            PathBuf::from("/opt/bambu-studio*"),
            home.join("opt/bambu-studio*/squashfs-root/AppRun"),
        ]
    }
}

fn discover_candidates() -> Vec<Candidate> {
    let home = dirs::home_dir().unwrap_or_default();
    let exes: Vec<PathBuf> = if cfg!(target_os = "macos") {
        let mut apps = vec![
            PathBuf::from("/Applications/BambuStudio.app"),
            home.join("Applications/BambuStudio.app"),
        ];
        apps.extend(subdirs(&home.join("Applications")).map(|d| d.join("BambuStudio.app")));
        apps.into_iter()
            .map(|app| app.join("Contents/MacOS/BambuStudio"))
            .collect()
    } else {
        let mut exes = vec![PathBuf::from("/usr/bin/bambu-studio")];
        for dir in prefixed_subdirs(Path::new("/opt"), "bambu-studio") {
            exes.extend(
                ["squashfs-root/AppRun", "AppRun", "bin/bambu-studio"].map(|rel| dir.join(rel)),
            );
        }
        exes.extend(
            prefixed_subdirs(&home.join("opt"), "bambu-studio")
                .map(|dir| dir.join("squashfs-root/AppRun")),
        );
        exes
    };
    exes.into_iter()
        .filter(|exe| exe.is_file())
        .map(|exe| Candidate {
            exe,
            profiles_dir: None,
        })
        .collect()
}

/// Immediate subdirectories, sorted so discovery order is stable.
fn subdirs(dir: &Path) -> impl Iterator<Item = PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    found.sort();
    found.into_iter()
}

fn prefixed_subdirs(dir: &Path, prefix: &'static str) -> impl Iterator<Item = PathBuf> {
    subdirs(dir).filter(move |path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(prefix))
    })
}

/// Maps an executable to its bundled `profiles/BBL` directory across the known layouts:
/// AppImage (`AppRun` beside `resources/`), macOS bundle (`MacOS/` beside `Resources/`),
/// and FHS installs (`bin/` beside `share/bambu-studio/`).
fn derive_profiles_dir(exe: &Path) -> Option<PathBuf> {
    let exe_dir = exe.parent()?;
    let up = exe_dir.parent();
    [
        Some(exe_dir.join("resources/profiles/BBL")),
        up.map(|d| d.join("Resources/profiles/BBL")),
        up.map(|d| d.join("resources/profiles/BBL")),
        up.map(|d| d.join("share/bambu-studio/resources/profiles/BBL")),
    ]
    .into_iter()
    .flatten()
    .find(|dir| dir.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probed(exe: &str, version: Option<&str>, profiles: &Path) -> Probed {
        Probed {
            exe: PathBuf::from(exe),
            profiles_dir: Some(profiles.to_path_buf()),
            version: version.map(|v| BambuVersion(v.to_owned())),
        }
    }

    #[test]
    fn parses_version_from_help_banner() {
        let help = "BambuStudio-02.08.02.61:\nUsage: bambu-studio [ OPTIONS ] [ file.3mf ]";
        assert_eq!(
            BambuVersion::from_help(help).map(|v| v.0).as_deref(),
            Some("02.08.02.61")
        );
        assert!(BambuVersion::from_help("Usage: slicer").is_none());
    }

    #[test]
    fn prefers_a_later_validated_candidate_over_an_earlier_unvalidated_one() {
        let profiles = Path::new("/profiles");
        let studio = select(vec![
            probed(
                "/Applications/BambuStudio.app/x",
                Some("02.07.01.62"),
                profiles,
            ),
            probed("/Users/o/Applications/B/x", Some("02.08.02.61"), profiles),
        ])
        .expect("validated candidate selected");
        assert_eq!(studio.exe, PathBuf::from("/Users/o/Applications/B/x"));
        assert!(studio.version.is_validated());
    }

    #[test]
    fn refuses_unvalidated_builds_and_names_their_versions() {
        let profiles = Path::new("/profiles");
        let err = select(vec![
            probed("/a", Some("02.07.01.62"), profiles),
            probed("/b", None, profiles),
        ])
        .expect_err("no validated build");
        let message = err.to_string();
        assert!(message.contains("/a (02.07.01.62)"), "{message}");
        assert!(message.contains("/b (unknown version)"), "{message}");
        assert!(message.contains("02.08.02.61"), "{message}");
    }
}
