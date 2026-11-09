use std::env;
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{io_err, BambuError, Result};

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

/// An executable found on disk, before its version is known.
struct Candidate {
    exe: PathBuf,
    profiles_dir: Option<PathBuf>,
}

/// An executable whose `--help` has been read.
struct Probed {
    exe: PathBuf,
    profiles_dir: Option<PathBuf>,
    version: Result<Option<BambuVersion>>,
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

/// Where Bambu Studio can come from, strongest first. The env var is the only candidate
/// when set; discovery runs only when it is not.
struct Sources {
    env_cli: Option<PathBuf>,
    env_profiles: Option<PathBuf>,
}

impl Sources {
    fn new() -> Self {
        Self {
            env_cli: env::var_os("BAMBU_STUDIO_CLI").map(PathBuf::from),
            env_profiles: env::var_os("BAMBU_STUDIO_PROFILES").map(PathBuf::from),
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
        let candidates = discover();
        if candidates.is_empty() {
            return Err(BambuError::StudioNotFound {
                searched: search_roots(),
            });
        }
        select(candidates.into_iter().map(Probed::of).collect())
    }
}

impl BambuStudio {
    /// Finds a validated Bambu Studio.
    ///
    /// `BAMBU_STUDIO_CLI` (with optional `BAMBU_STUDIO_PROFILES`) comes first and is the only
    /// candidate when set. Otherwise the platform install locations are searched in order and
    /// the first validated build wins over any earlier unvalidated one. There is no fallback
    /// to an unvalidated build.
    pub fn locate() -> Result<Self> {
        Sources::new().locate(discover_candidates)
    }
}

/// Runs `exe --help` in a private scratch directory, because Bambu Studio writes
/// `result.json` into its working directory even for `--help`.
fn detect_version(exe: &Path) -> Result<Option<BambuVersion>> {
    detect_version_with_timeout(exe, Duration::from_secs(15))
}

fn detect_version_with_timeout(exe: &Path, timeout: Duration) -> Result<Option<BambuVersion>> {
    let Ok(exe) = std::path::absolute(exe) else {
        return Ok(None);
    };
    let Ok(scratch) = tempfile::tempdir() else {
        return Ok(None);
    };
    // Files cannot fill a pipe or wait for EOF on a descriptor a descendant inherited.
    let stdout = scratch.path().join("stdout");
    let stderr = scratch.path().join("stderr");
    let output = File::create(&stdout).map_err(io_err(&stdout))?;
    let errors = File::create(&stderr).map_err(io_err(&stderr))?;
    let start = Instant::now();
    let Ok(mut child) = Command::new(&exe)
        .arg("--help")
        .current_dir(scratch.path())
        .stdin(Stdio::null())
        .stdout(output)
        .stderr(errors)
        .spawn()
    else {
        return Ok(None);
    };
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(_)) => break Ok(()),
            Ok(None) if start.elapsed() >= timeout => {
                log::warn!(
                    "bambu: version check timed out after {} ms for {}",
                    timeout.as_millis(),
                    exe.display()
                );
                break Err(BambuError::VersionCheckTimedOut { exe: exe.clone() });
            }
            Ok(None) => std::thread::sleep(
                Duration::from_millis(10).min(timeout.saturating_sub(start.elapsed())),
            ),
            Err(source) => {
                break Err(BambuError::Io {
                    path: exe.clone(),
                    source,
                })
            }
        }
    };
    if outcome.is_err() {
        let killed = child.kill();
        let reaped = child.wait();
        killed.map_err(io_err(&exe))?;
        reaped.map_err(io_err(&exe))?;
    }
    outcome?;
    for path in [stdout, stderr] {
        let mut output = Vec::new();
        File::open(&path)
            .map_err(io_err(&path))?
            .take(1024 * 1024)
            .read_to_end(&mut output)
            .map_err(io_err(&path))?;
        if let Some(version) = BambuVersion::from_help(&String::from_utf8_lossy(&output)) {
            return Ok(Some(version));
        }
    }
    Ok(None)
}

/// Picks the first validated candidate, or explains what was found instead.
fn select(mut probed: Vec<Probed>) -> Result<BambuStudio> {
    let chosen = probed
        .iter()
        .position(|p| matches!(&p.version, Ok(Some(version)) if version.is_validated()));
    let Some(index) = chosen else {
        let found = probed
            .into_iter()
            .map(|p| {
                Ok(FoundBuild {
                    path: p.exe,
                    version: p.version?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        return Err(BambuError::UnvalidatedStudio { found });
    };
    let Probed {
        exe,
        profiles_dir,
        version,
    } = probed.swap_remove(index);
    let version = version?.ok_or(BambuError::VersionUndetected { exe: exe.clone() })?;
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

    #[cfg(unix)]
    #[test]
    fn a_hung_version_probe_times_out_and_reaps_its_process() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};

        let root = tempfile::tempdir().expect("tempdir");
        let exe = root.path().join("BambuStudio");
        let pid_file = root.path().join("pid");
        std::fs::write(
            &exe,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nexec sleep 86400\n",
                pid_file.display()
            ),
        )
        .expect("script");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let (send, receive) = std::sync::mpsc::channel();
        let expected_exe = exe.clone();
        let start = Instant::now();
        let probe = std::thread::spawn(move || {
            let result = detect_version_with_timeout(&exe, Duration::from_secs(1));
            send.send(result).expect("probe result");
        });
        let result = receive.recv_timeout(Duration::from_secs(5));
        let elapsed = start.elapsed();
        let pid = std::fs::read_to_string(&pid_file).expect("probe pid");
        if result.is_err() {
            Command::new("kill")
                .arg(pid.trim())
                .status()
                .expect("stop the unbounded probe");
        }
        probe.join().expect("probe thread");
        assert!(
            result.is_ok(),
            "version check exceeded the outer 5 s limit with a 1 s probe limit"
        );
        let error = result
            .expect("bounded result")
            .expect_err("the timeout has its own error");
        assert!(
            matches!(error, BambuError::VersionCheckTimedOut { .. }),
            "{error}"
        );
        let message = error.to_string();
        assert!(
            message.contains(&format!(
                "Bambu Studio at {} did not answer",
                expected_exe.display()
            )),
            "{message}"
        );
        for guidance in [
            "did not answer its version check",
            "macOS",
            "Applications",
            "try again",
        ] {
            assert!(message.contains(guidance), "{message}");
        }
        assert!(elapsed < Duration::from_secs(3), "probe took {elapsed:?}");
        assert!(
            !Command::new("kill")
                .args(["-0", pid.trim()])
                .status()
                .expect("check probe pid")
                .success(),
            "the probe is gone and reaped"
        );
    }

    #[cfg(unix)]
    #[test]
    fn help_output_cannot_hold_the_probe_open() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().expect("tempdir");
        let exe = root.path().join("BambuStudio");
        let holder_pid = root.path().join("holder-pid");
        for body in [
            "dd if=/dev/zero bs=65536 count=32 2>/dev/null\necho 'BambuStudio-02.08.02.61:' >&2\n"
                .to_owned(),
            format!(
                "sleep 5 &\necho $! > '{}'\necho 'BambuStudio-02.08.02.61:'\n",
                holder_pid.display()
            ),
        ] {
            std::fs::write(&exe, format!("#!/bin/sh\n{body}")).expect("script");
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            let start = Instant::now();
            let result = detect_version_with_timeout(&exe, Duration::from_secs(1));
            let elapsed = start.elapsed();
            if let Ok(pid) = std::fs::read_to_string(&holder_pid) {
                assert!(Command::new("kill")
                    .arg(pid.trim())
                    .status()
                    .expect("stop descriptor holder")
                    .success());
            }
            assert!(
                elapsed < Duration::from_secs(3),
                "output held the probe open for {elapsed:?}"
            );
            assert_eq!(
                result.expect("probe").expect("version").as_str(),
                "02.08.02.61"
            );
        }
    }

    #[test]
    fn discovery_surfaces_a_timeout_unless_a_validated_candidate_is_available() {
        let timed_out = || Probed {
            exe: PathBuf::from("/held/BambuStudio"),
            profiles_dir: None,
            version: Err(BambuError::VersionCheckTimedOut {
                exe: PathBuf::from("/held/BambuStudio"),
            }),
        };
        let error = select(vec![
            probed("/unknown", None, Path::new("/profiles")),
            timed_out(),
        ])
        .expect_err("timeout is kept");
        assert!(
            matches!(error, BambuError::VersionCheckTimedOut { .. }),
            "{error}"
        );
        let studio = select(vec![
            timed_out(),
            probed("/validated", Some("02.08.02.61"), Path::new("/profiles")),
        ])
        .expect("later validated build");
        assert_eq!(studio.exe, Path::new("/validated"));
    }

    fn probed(exe: &str, version: Option<&str>, profiles: &Path) -> Probed {
        Probed {
            exe: PathBuf::from(exe),
            profiles_dir: Some(profiles.to_path_buf()),
            version: Ok(version.map(|v| BambuVersion(v.to_owned()))),
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
    ///
    /// The script is written under a temporary name, closed, and renamed into place, then run once before the
    /// helper returns. Another test thread that forks while the script's write descriptor is open keeps that
    /// descriptor until its child execs, and until then running the script fails with ETXTBSY. The probe waits
    /// that out, so the code under test never sees it. Any other spawn error fails the helper.
    #[cfg(unix)]
    fn fake_app(root: &Path, name: &str, version: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let app = root.join(name);
        std::fs::create_dir_all(app.join("Contents/MacOS")).expect("MacOS dir");
        std::fs::create_dir_all(app.join("Contents/Resources/profiles/BBL")).expect("profiles dir");
        let exe = app.join("Contents/MacOS/BambuStudio");
        let staged = app.join("Contents/MacOS/.BambuStudio.writing");
        std::fs::write(
            &staged,
            format!("#!/bin/sh\necho 'BambuStudio-{version}:'\n"),
        )
        .expect("script");
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        std::fs::rename(&staged, &exe).expect("rename the script into place");
        for _ in 0..50 {
            match std::process::Command::new(&exe).output() {
                Ok(output) => {
                    assert!(
                        output.status.success(),
                        "{} exited {}",
                        exe.display(),
                        output.status
                    );
                    return app;
                }
                // ETXTBSY: an inherited write descriptor is still open in another thread's forked child.
                Err(err) if err.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(err) => panic!("running {}: {err}", exe.display()),
            }
        }
        panic!("{} stayed busy (ETXTBSY) for 50 tries", exe.display());
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
    fn the_env_var_wins_over_discovery() {
        let root = tempfile::tempdir().expect("tempdir");
        let discovered = fake_app(root.path(), "Discovered.app", "02.08.02.61");
        let env = fake_app(root.path(), "Env.app", "02.08.02.61");

        let from_env = Sources {
            env_cli: Some(exe_of(&env)),
            env_profiles: None,
        }
        .locate(discovers(&discovered))
        .expect("env app");
        assert_eq!(from_env.exe, exe_of(&env));

        let from_discovery = Sources {
            env_cli: None,
            env_profiles: None,
        }
        .locate(discovers(&discovered))
        .expect("discovered app");
        assert_eq!(from_discovery.exe, exe_of(&discovered));
        assert_eq!(
            from_discovery.profiles_dir,
            discovered.join("Contents/Resources/profiles/BBL")
        );
    }

    /// Child half of the probe test. It runs only when the parent sets `M3D_PROBE_EXE`,
    /// in a process whose working directory the parent chose.
    #[cfg(unix)]
    #[test]
    fn probe_child() {
        if let Some(exe) = env::var_os("M3D_PROBE_EXE") {
            let version = detect_version(Path::new(&exe)).expect("probe completes");
            println!(
                "probe-version={}",
                version.as_ref().map_or("none", BambuVersion::as_str)
            );
        }
    }

    #[cfg(unix)]
    fn files_in(dir: &Path) -> std::collections::BTreeMap<std::ffi::OsString, Vec<u8>> {
        std::fs::read_dir(dir)
            .expect("read dir")
            .map(|entry| {
                let entry = entry.expect("dir entry");
                let bytes = std::fs::read(entry.path()).expect("read file");
                (entry.file_name(), bytes)
            })
            .collect()
    }

    /// Real Bambu Studio writes `result.json` into its working directory even for `--help`.
    #[cfg(unix)]
    #[test]
    fn version_probe_leaves_the_callers_directory_alone() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("tempdir");
        let bin = root.path().join("bin");
        let scratch_root = root.path().join("tmp");
        let kept = root.path().join("kept");
        let fresh = root.path().join("fresh");
        for dir in [&bin, &scratch_root, &kept, &fresh] {
            std::fs::create_dir(dir).expect("dir");
        }
        std::fs::write(kept.join("result.json"), b"{\"mine\":true}\n").expect("result.json");
        std::fs::write(kept.join("notes.txt"), b"keep me").expect("notes");
        std::fs::write(fresh.join("notes.txt"), b"keep me too").expect("notes");
        for (name, banner) in [
            ("studio", "BambuStudio-02.08.02.61:"),
            ("garbled", "Usage: slicer"),
        ] {
            let path = bin.join(name);
            std::fs::write(
                &path,
                format!(
                    "#!/bin/sh\necho '{banner}'\nprintf '{{\"return_code\":0}}' > result.json\n"
                ),
            )
            .expect("script");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }

        let test_name = format!(
            "{}::probe_child",
            module_path!().split_once("::").expect("crate").1
        );
        let probe = |cwd: &Path, exe: &str| {
            let before = files_in(cwd);
            let output = Command::new(env::current_exe().expect("test binary"))
                .args(["--exact", &test_name, "--nocapture", "--test-threads=1"])
                .current_dir(cwd)
                .env("M3D_PROBE_EXE", exe)
                .env("TMPDIR", &scratch_root)
                .output()
                .expect("child test");
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success(),
                "{stdout}{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(files_in(cwd), before, "{exe} changed {}", cwd.display());
            assert!(
                std::fs::read_dir(&scratch_root)
                    .expect("read scratch root")
                    .next()
                    .is_none(),
                "{exe} left scratch behind"
            );
            stdout
                .lines()
                .find_map(|line| {
                    line.split_once("probe-version=")
                        .map(|(_, version)| version)
                })
                .expect("probe output")
                .to_owned()
        };

        assert_eq!(probe(&kept, "../bin/studio"), "02.08.02.61");
        assert_eq!(probe(&fresh, "../bin/studio"), "02.08.02.61");
        assert_eq!(probe(&fresh, "../bin/garbled"), "none");
        assert_eq!(probe(&fresh, "../bin/missing"), "none");
    }
}
