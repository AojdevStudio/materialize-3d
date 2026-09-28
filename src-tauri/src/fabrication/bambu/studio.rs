use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::{BambuError, Result};

/// Bambu Studio builds whose CLI slicing has been proven end to end.
pub const VALIDATED_VERSIONS: &[&str] = &["02.08.02.61"];

/// The official release page for the validated build.
pub const DOWNLOAD_URL: &str = "https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61";

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

/// A Bambu Studio executable and the version it reported, if any.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FoundBuild {
    pub path: PathBuf,
    pub version: Option<BambuVersion>,
}

impl fmt::Display for FoundBuild {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let version = self
            .version
            .as_ref()
            .map_or("unknown version", BambuVersion::as_str);
        write!(f, "{} ({version})", self.path.display())
    }
}

/// What the app would slice with right now, for Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StudioState {
    Found {
        path: PathBuf,
        version: BambuVersion,
    },
    Unvalidated {
        builds: Vec<FoundBuild>,
    },
    NotFound {
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioStatus {
    #[serde(flatten)]
    pub state: StudioState,
    /// The app the person chose in Settings, if any.
    pub chosen_path: Option<PathBuf>,
    pub validated_versions: &'static [&'static str],
    pub download_url: &'static str,
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

impl Probed {
    fn of(candidate: Candidate) -> Self {
        Self {
            version: detect_version(&candidate.exe),
            exe: candidate.exe,
            profiles_dir: candidate.profiles_dir,
        }
    }
}

/// Where Bambu Studio can come from, strongest first. The env var and the person's choice
/// are each the only candidate when set; discovery runs only when neither is.
struct Sources {
    env_cli: Option<PathBuf>,
    env_profiles: Option<PathBuf>,
    chosen: Option<PathBuf>,
}

impl Sources {
    fn new(chosen: Option<&Path>) -> Self {
        Self {
            env_cli: env::var_os("BAMBU_STUDIO_CLI").map(PathBuf::from),
            env_profiles: env::var_os("BAMBU_STUDIO_PROFILES").map(PathBuf::from),
            chosen: chosen.map(Path::to_path_buf),
        }
    }

    fn locate(&self, discover: impl FnOnce() -> Vec<Candidate>) -> Result<BambuStudio> {
        if let Some(exe) = &self.env_cli {
            if !exe.is_file() {
                return Err(BambuError::StudioNotFound {
                    searched: vec![exe.clone()],
                });
            }
            let candidate = Candidate {
                exe: exe.clone(),
                profiles_dir: self.env_profiles.clone(),
            };
            return select(vec![Probed::of(candidate)]);
        }
        if let Some(chosen) = &self.chosen {
            return BambuStudio::at(chosen);
        }
        let candidates = discover();
        if candidates.is_empty() {
            return Err(BambuError::StudioNotFound {
                searched: search_roots(),
            });
        }
        select(candidates.into_iter().map(Probed::of).collect())
    }

    fn status(&self, discover: impl FnOnce() -> Vec<Candidate>) -> StudioStatus {
        let state = match self.locate(discover) {
            Ok(studio) => StudioState::Found {
                path: studio.exe,
                version: studio.version,
            },
            Err(BambuError::UnvalidatedStudio { found }) => {
                StudioState::Unvalidated { builds: found }
            }
            Err(BambuError::ChosenStudioUnvalidated { build }) => StudioState::Unvalidated {
                builds: vec![build],
            },
            Err(other) => StudioState::NotFound {
                detail: other.to_string(),
            },
        };
        StudioStatus {
            state,
            chosen_path: self.chosen.clone(),
            validated_versions: VALIDATED_VERSIONS,
            download_url: DOWNLOAD_URL,
        }
    }
}

/// Reports what [`BambuStudio::locate`] would find, given the person's choice.
pub fn studio_status(chosen: Option<&Path>) -> StudioStatus {
    Sources::new(chosen).status(discover_candidates)
}

impl BambuStudio {
    /// Finds a validated Bambu Studio.
    ///
    /// `BAMBU_STUDIO_CLI` (with optional `BAMBU_STUDIO_PROFILES`) comes first, then the app
    /// the person chose in Settings (`chosen`); either is the only candidate when set.
    /// Otherwise the platform install locations are searched in order and the first
    /// validated build wins over any earlier unvalidated one. There is no fallback to an
    /// unvalidated build.
    pub fn locate(chosen: Option<&Path>) -> Result<Self> {
        Sources::new(chosen).locate(discover_candidates)
    }

    /// Probes one app a person chose: a macOS `.app` bundle or an executable. Refuses a
    /// missing path and an unvalidated or unreadable version.
    pub fn at(chosen: &Path) -> Result<Self> {
        let exe = if chosen.is_dir() {
            chosen.join("Contents/MacOS/BambuStudio")
        } else {
            chosen.to_path_buf()
        };
        if !exe.is_file() {
            return Err(BambuError::ChosenStudioMissing {
                path: chosen.to_path_buf(),
            });
        }
        let probed = Probed::of(Candidate {
            exe,
            profiles_dir: None,
        });
        if !probed
            .version
            .as_ref()
            .is_some_and(BambuVersion::is_validated)
        {
            return Err(BambuError::ChosenStudioUnvalidated {
                build: FoundBuild {
                    path: probed.exe,
                    version: probed.version,
                },
            });
        }
        select(vec![probed])
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
            .into_iter()
            .map(|p| FoundBuild {
                path: p.exe,
                version: p.version,
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

    /// A macOS-style bundle whose executable prints `version` the way `--help` does.
    #[cfg(unix)]
    fn fake_app(root: &Path, name: &str, version: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let app = root.join(name);
        std::fs::create_dir_all(app.join("Contents/MacOS")).expect("MacOS dir");
        std::fs::create_dir_all(app.join("Contents/Resources/profiles/BBL")).expect("profiles dir");
        let exe = app.join("Contents/MacOS/BambuStudio");
        std::fs::write(&exe, format!("#!/bin/sh\necho 'BambuStudio-{version}:'\n"))
            .expect("script");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        app
    }

    #[cfg(unix)]
    fn exe_of(app: &Path) -> PathBuf {
        app.join("Contents/MacOS/BambuStudio")
    }

    #[cfg(unix)]
    fn discovers(app: &Path) -> impl FnOnce() -> Vec<Candidate> + '_ {
        move || {
            vec![Candidate {
                exe: exe_of(app),
                profiles_dir: None,
            }]
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_stored_choice_wins_over_discovery_and_loses_to_the_env_var() {
        let root = tempfile::tempdir().expect("tempdir");
        let discovered = fake_app(root.path(), "Discovered.app", "02.08.02.61");
        let chosen = fake_app(root.path(), "Chosen.app", "02.08.02.61");
        let env = fake_app(root.path(), "Env.app", "02.08.02.61");

        let from_choice = Sources {
            env_cli: None,
            env_profiles: None,
            chosen: Some(chosen.clone()),
        }
        .locate(discovers(&discovered))
        .expect("chosen app");
        assert_eq!(from_choice.exe, exe_of(&chosen));
        assert_eq!(
            from_choice.profiles_dir,
            chosen.join("Contents/Resources/profiles/BBL")
        );

        let from_env = Sources {
            env_cli: Some(exe_of(&env)),
            env_profiles: None,
            chosen: Some(chosen),
        }
        .locate(discovers(&discovered))
        .expect("env app");
        assert_eq!(from_env.exe, exe_of(&env));

        let from_discovery = Sources {
            env_cli: None,
            env_profiles: None,
            chosen: None,
        }
        .locate(discovers(&discovered))
        .expect("discovered app");
        assert_eq!(from_discovery.exe, exe_of(&discovered));
    }

    #[cfg(unix)]
    #[test]
    fn a_stored_unvalidated_or_missing_app_is_refused_and_discovery_is_not_used_instead() {
        let root = tempfile::tempdir().expect("tempdir");
        let discovered = fake_app(root.path(), "Discovered.app", "02.08.02.61");
        let old = fake_app(root.path(), "Old.app", "02.07.01.62");
        let gone = root.path().join("Gone.app");

        let refused = Sources {
            env_cli: None,
            env_profiles: None,
            chosen: Some(old.clone()),
        }
        .locate(discovers(&discovered))
        .expect_err("unvalidated choice refused");
        let message = refused.to_string();
        assert!(
            message.contains("Old.app") && message.contains("02.07.01.62"),
            "{message}"
        );
        assert!(message.contains("not a validated version"), "{message}");

        let missing = Sources {
            env_cli: None,
            env_profiles: None,
            chosen: Some(gone.clone()),
        }
        .locate(discovers(&discovered))
        .expect_err("missing choice refused");
        let message = missing.to_string();
        assert!(message.contains(&gone.display().to_string()), "{message}");
        assert!(message.contains("not found"), "{message}");

        assert!(
            BambuStudio::at(&old).is_err(),
            "choosing an unvalidated app is refused"
        );
        assert!(
            BambuStudio::at(&gone).is_err(),
            "choosing a missing app is refused"
        );
    }

    #[cfg(unix)]
    #[test]
    fn status_reports_found_unvalidated_and_not_found() {
        let root = tempfile::tempdir().expect("tempdir");
        let good = fake_app(root.path(), "Good.app", "02.08.02.61");
        let old = fake_app(root.path(), "Old.app", "02.07.01.62");
        let gone = root.path().join("Gone.app");
        let status = |chosen: &Path| {
            Sources {
                env_cli: None,
                env_profiles: None,
                chosen: Some(chosen.to_path_buf()),
            }
            .status(Vec::new)
        };

        let found = status(&good);
        assert_eq!(
            found.state,
            StudioState::Found {
                path: exe_of(&good),
                version: BambuVersion("02.08.02.61".into())
            }
        );
        assert_eq!(found.chosen_path.as_deref(), Some(good.as_path()));
        let json = serde_json::to_value(&found).expect("json");
        assert_eq!(json["state"], "found");
        assert_eq!(json["version"], "02.08.02.61");
        assert_eq!(
            json["validatedVersions"],
            serde_json::json!(["02.08.02.61"])
        );
        assert_eq!(json["downloadUrl"], DOWNLOAD_URL);

        assert_eq!(
            status(&old).state,
            StudioState::Unvalidated {
                builds: vec![FoundBuild {
                    path: exe_of(&old),
                    version: Some(BambuVersion("02.07.01.62".into()))
                }]
            }
        );

        let StudioState::NotFound { detail } = status(&gone).state else {
            panic!("a missing choice is not found");
        };
        assert!(detail.contains(&gone.display().to_string()), "{detail}");

        let nothing = Sources {
            env_cli: None,
            env_profiles: None,
            chosen: None,
        }
        .status(Vec::new);
        assert!(
            matches!(nothing.state, StudioState::NotFound { .. }),
            "{:?}",
            nothing.state
        );
        assert_eq!(nothing.chosen_path, None);
    }
}
