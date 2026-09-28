//! `build_sign`: one spec in, one verified (or failed) sign revision out.
//!
//! GUI commands, the in-app agent, and external MCP callers all call
//! [`build_sign`]; only the `actor` differs. The pipeline never holds the
//! database lock while geometry or slicing runs, writes every artifact into a
//! private `.partial-<id>` directory, and renames it into place before the
//! revision is recorded. A crash leaves either a complete record or leftovers
//! that [`reconcile_startup`] removes on the next launch.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use super::bambu::{self, BambuError, BambuStudio, Check, ResolvedPresets, SliceReport};
use super::revisions::{
    self, Actor, Artifacts, BuildClaim, BuildState, LineageId, NewBuild, RecordedCheck, RevisionError, RevisionId,
    Sha256Hex, SignRevision, SlicerIdentity,
};
use super::sign::{self, GeometryCheck, SignError, ValidSignSpec, P2S_PROJECT_SETTINGS_TEMPLATE};
use super::studio_choice;
use crate::state::AppState;

/// Bump when geometry or packaging output changes for the same spec, so a
/// retry after an upgrade builds a new revision instead of reusing an old one.
const PIPELINE_VERSION: &str = "sign-pipeline-1";
const PREVIEW_PX_PER_MM: f64 = 4.0;

/// Where builds live on disk.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub signs_dir: PathBuf,
    pub preset_cache: PathBuf,
}

impl Workspace {
    pub fn new(app_data_dir: &Path, app_cache_dir: &Path) -> Self {
        Self {
            signs_dir: app_data_dir.join("signs"),
            preset_cache: app_cache_dir.join("bambu-presets"),
        }
    }

    fn partial_dir(&self, id: &str) -> PathBuf {
        self.signs_dir.join(format!(".partial-{id}"))
    }

    fn final_dir(&self, id: &str) -> PathBuf {
        self.signs_dir.join(id)
    }

    /// Removes `.partial-*` directories left by builds that never finished.
    /// Part of [`reconcile_startup`].
    pub fn remove_partials(&self) -> std::io::Result<usize> {
        let entries = match fs::read_dir(&self.signs_dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(err) => return Err(err),
        };
        let mut removed = 0;
        for entry in entries {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(".partial-") {
                fs::remove_dir_all(entry.path())?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

/// What startup cleanup found and removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupCleanup {
    pub interrupted: usize,
    pub removed_dirs: usize,
}

/// Recovers from builds the app stopped in the middle of. Run once at startup,
/// before anything can claim a new build. A build interrupted after its
/// rename left a complete-looking `signs/<id>` that no revision refers to, so
/// the directory of every build still recorded as running is removed before
/// the build is marked failed; a crash part way through is finished next launch.
pub fn reconcile_startup(state: &AppState, workspace: &Workspace) -> Result<StartupCleanup, BuildError> {
    let unfinished = with_db(state, |conn| revisions::unfinished_builds(conn))?;
    let mut removed_dirs = 0;
    for id in &unfinished {
        if remove_dir_if_present(&workspace.final_dir(id.as_str()))? {
            removed_dirs += 1;
        }
    }
    let interrupted = with_db(state, |conn| revisions::reconcile_interrupted(conn))?;
    removed_dirs += workspace.remove_partials()?;
    Ok(StartupCleanup { interrupted, removed_dirs })
}

/// True when the directory existed and was removed.
fn remove_dir_if_present(dir: &Path) -> std::io::Result<bool> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// Coarse progress, in order. Each step is reported once it completes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildStep {
    SpecValidated,
    GeometryBuilt,
    PackageWritten,
    Sliced,
    Verified,
}

#[derive(Debug, Serialize)]
pub struct BuildOutcome {
    pub revision: SignRevision,
    /// True when an identical build already existed and nothing ran.
    pub reused: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error(transparent)]
    Spec(#[from] sign::SpecError),
    /// Bambu Studio is missing or not a validated version. The message is what
    /// a person in the Signs view and the in-app agent read, so it ends with
    /// what to do next.
    #[error(
        "{0}. Download Bambu Studio {} from {}, then choose it in Settings > Bambu Studio.",
        bambu::VALIDATED_VERSIONS.join(" or "),
        bambu::DOWNLOAD_URL
    )]
    Studio(BambuError),
    #[error("slicer unavailable: {0}")]
    Slicer(BambuError),
    #[error("build cancelled")]
    Cancelled,
    #[error(transparent)]
    Revision(#[from] RevisionError),
    #[error("database is not initialized")]
    NoDatabase,
    #[error("build failed: {0}")]
    Failed(String),
}

impl From<BambuError> for BuildError {
    fn from(err: BambuError) -> Self {
        match err {
            BambuError::Cancelled => BuildError::Cancelled,
            other => BuildError::Failed(other.to_string()),
        }
    }
}

impl From<SignError> for BuildError {
    fn from(err: SignError) -> Self {
        match err {
            SignError::Spec(spec) => BuildError::Spec(spec),
            other => BuildError::Failed(other.to_string()),
        }
    }
}

impl From<serde_json::Error> for BuildError {
    fn from(err: serde_json::Error) -> Self {
        BuildError::Failed(err.to_string())
    }
}

impl From<std::io::Error> for BuildError {
    fn from(err: std::io::Error) -> Self {
        BuildError::Failed(err.to_string())
    }
}

pub struct BuildRequest {
    pub spec: Value,
    pub lineage_id: Option<LineageId>,
    pub actor: Actor,
}

/// Runs with the shared connection for the shortest possible time.
pub fn with_db<T>(state: &AppState, f: impl FnOnce(&mut Connection) -> Result<T, RevisionError>) -> Result<T, BuildError> {
    let mut guard = state.db.lock().map_err(|_| BuildError::Failed("database lock poisoned".into()))?;
    let conn = guard.as_mut().ok_or(BuildError::NoDatabase)?;
    Ok(f(conn)?)
}

/// Builds, slices, and verifies a sign. Identical input returns the existing
/// live revision without doing any work. A validation error or a missing
/// slicer fails before any revision is recorded; anything later is recorded
/// on the revision as a failure.
pub fn build_sign(
    state: &AppState,
    workspace: &Workspace,
    request: BuildRequest,
    progress: &dyn Fn(BuildStep),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<BuildOutcome, BuildError> {
    let spec = ValidSignSpec::parse(serde_json::from_value(request.spec.clone()).map_err(sign::SpecError::from)?)?;
    let spec_sha256 = Sha256Hex::try_from(sign::spec_hash(&spec))?;
    progress(BuildStep::SpecValidated);

    let chosen = studio_choice::chosen(state).map_err(BuildError::Failed)?;
    let studio = BambuStudio::locate(chosen.as_deref()).map_err(BuildError::Studio)?;
    let template: Value = serde_json::from_str(P2S_PROJECT_SETTINGS_TEMPLATE)
        .map_err(|e| BuildError::Failed(format!("project settings template: {e}")))?;
    let presets = bambu::resolve_presets(&studio, &template_selection(&template)?, &workspace.preset_cache)
        .map_err(BuildError::Slicer)?;
    let build_key = Sha256Hex::of_bytes(
        [PIPELINE_VERSION, spec_sha256.as_str(), &presets.app_version, &presets.profile_version, P2S_PROJECT_SETTINGS_TEMPLATE]
            .join("\n")
            .as_bytes(),
    );

    let new_build = NewBuild {
        lineage_id: request.lineage_id,
        title: spec.title().to_owned(),
        spec: request.spec,
        spec_sha256,
        build_key,
        requested_by: request.actor,
    };
    // An identical build already running is awaited, never reported as done:
    // once it settles, a verified result is reused and a failed one is retried.
    let revision = loop {
        match with_db(state, |conn| revisions::claim_build(conn, new_build.clone()))? {
            BuildClaim::Started(revision) => break revision,
            BuildClaim::Existing(revision) if !matches!(revision.build, BuildState::Building) => {
                return Ok(BuildOutcome { revision, reused: true });
            }
            BuildClaim::Existing(running) => wait_until_settled(state, &running.id, is_cancelled)?,
        }
    };

    let id = revision.id.to_string();
    let (partial, final_dir) = (workspace.partial_dir(&id), workspace.final_dir(&id));
    let mut unfinished = UnfinishedBuild::new(state, &revision.id, &partial, &final_dir);
    let artifacts = run_pipeline(&spec, &template, &studio, &presets, &partial, &final_dir, progress, is_cancelled)
        .map_err(|err| unfinished.fail(err))?;
    let finished = unfinished.settle(artifacts)?;
    if matches!(finished.build, BuildState::Verified { .. }) {
        progress(BuildStep::Verified);
    }
    Ok(BuildOutcome { revision: finished, reused: false })
}

const SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(250);

fn wait_until_settled(state: &AppState, id: &RevisionId, is_cancelled: &dyn Fn() -> bool) -> Result<(), BuildError> {
    loop {
        if is_cancelled() {
            return Err(BuildError::Cancelled);
        }
        let current = with_db(state, |conn| revisions::get(conn, id))?;
        if !matches!(current.build, BuildState::Building) {
            return Ok(());
        }
        std::thread::sleep(SETTLE_POLL);
    }
}

/// A claimed build that has not been recorded as finished. Dropping it before
/// the build settles, through an error or a panic, marks the revision failed
/// and removes its directory, so no revision stays `building` and no directory
/// outlives a failed build while the app keeps running.
struct UnfinishedBuild<'a> {
    state: &'a AppState,
    id: &'a RevisionId,
    partial: &'a Path,
    final_dir: &'a Path,
    /// The partial directory has been renamed to `final_dir`.
    placed: bool,
    settled: bool,
}

impl<'a> UnfinishedBuild<'a> {
    fn new(state: &'a AppState, id: &'a RevisionId, partial: &'a Path, final_dir: &'a Path) -> Self {
        Self { state, id, partial, final_dir, placed: false, settled: false }
    }

    /// Moves the finished partial directory into place and records the build.
    fn settle(mut self, artifacts: Artifacts) -> Result<SignRevision, BuildError> {
        fs::rename(self.partial, self.final_dir).map_err(|err| self.fail(err.into()))?;
        self.placed = true;
        let finished = with_db(self.state, |conn| revisions::finish_build(conn, self.id, artifacts)).map_err(|err| self.fail(err))?;
        self.settled = true;
        Ok(finished)
    }

    fn fail(&mut self, err: BuildError) -> BuildError {
        self.record_failure(&err.to_string());
        err
    }

    fn record_failure(&mut self, reason: &str) {
        self.settled = true;
        let _ = fs::remove_dir_all(self.partial);
        match with_db(self.state, |conn| revisions::fail_build(conn, self.id, reason)) {
            // The revision moved from building to failed, so it has no artifacts
            // on record and nothing refers to its placed directory.
            Ok(_) if self.placed => {
                if let Err(err) = remove_dir_if_present(self.final_dir) {
                    log::error!("build {}: could not remove {}: {err}", self.id, self.final_dir.display());
                }
            }
            Ok(_) => {}
            // Still `building` if the database is failing; startup reconciliation
            // removes the directory and records the failure next launch.
            Err(err) => log::error!("build {}: could not record failure ({reason}): {err}", self.id),
        }
    }
}

impl Drop for UnfinishedBuild<'_> {
    fn drop(&mut self) {
        if !self.settled {
            self.record_failure(if std::thread::panicking() { "build panicked" } else { "build ended without a result" });
        }
    }
}

/// The preset names a generated package declares are the presets it is
/// verified against, so the handoff file and the verified slice agree.
fn template_selection(template: &Value) -> Result<bambu::PresetSelection, BuildError> {
    let text = |key: &str| {
        template
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| BuildError::Failed(format!("template is missing {key}")))
    };
    let filaments = template
        .get("filament_settings_id")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>())
        .filter(|items| !items.is_empty())
        .ok_or_else(|| BuildError::Failed("template is missing filament_settings_id".into()))?;
    Ok(bambu::PresetSelection { machine: text("printer_settings_id")?, process: text("print_settings_id")?, filaments })
}

#[allow(clippy::too_many_arguments)]
fn run_pipeline(
    spec: &ValidSignSpec,
    template: &Value,
    studio: &BambuStudio,
    presets: &ResolvedPresets,
    partial: &Path,
    final_dir: &Path,
    progress: &dyn Fn(BuildStep),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Artifacts, BuildError> {
    let cancelled = || if is_cancelled() { Err(BuildError::Cancelled) } else { Ok(()) };
    fs::create_dir_all(partial)?;
    fs::write(partial.join("spec.json"), serde_json::to_vec_pretty(spec)?)?;

    let geometry = sign::build_geometry(spec)?;
    let geometry_checks = sign::check_geometry(&geometry);
    progress(BuildStep::GeometryBuilt);
    cancelled()?;

    let package = partial.join("sign.3mf");
    let info = sign::write_package(&geometry, spec, template, &package)?;
    set_read_only(&package)?;
    fs::write(partial.join("preview.png"), sign::render_preview(&geometry, PREVIEW_PX_PER_MM)?)?;
    progress(BuildStep::PackageWritten);
    cancelled()?;

    let slice_dir = partial.join("slice");
    let report = bambu::slice_project(studio, presets, &package, &slice_dir, is_cancelled)?;
    progress(BuildStep::Sliced);

    let footprints = bambu::part_footprints(&package)?;
    let mut checks: Vec<RecordedCheck> = geometry_checks.iter().map(recorded_geometry).collect();
    checks.extend(bambu::verify(&report, &footprints, presets).iter().map(recorded_slice));
    checks.push(handoff_matches_slice(template, spec, &report));
    fs::write(partial.join("checks.json"), serde_json::to_vec_pretty(&checks)?)?;

    let gcode_sha256 = report
        .gcode
        .first()
        .map(|file| Sha256Hex::try_from(file.sha256.clone()))
        .transpose()?
        .ok_or_else(|| BuildError::Failed("slice produced no G-code".into()))?;
    let rebase = |path: &Path| final_dir.join(path.strip_prefix(partial).unwrap_or(path));
    Ok(Artifacts {
        revision_dir: final_dir.to_path_buf(),
        package_path: rebase(&package),
        package_sha256: Sha256Hex::try_from(info.sha256)?,
        preview_path: final_dir.join("preview.png"),
        slice_dir: rebase(&slice_dir),
        gcode_sha256,
        slicer: SlicerIdentity {
            name: "Bambu Studio".into(),
            version: presets.app_version.clone(),
            profile_version: presets.profile_version.clone(),
        },
        effective_settings: serde_json::to_value(&report.effective)?,
        checks,
    })
}

fn set_read_only(path: &Path) -> std::io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

fn recorded_geometry(check: &GeometryCheck) -> RecordedCheck {
    RecordedCheck {
        id: format!("geometry.{}.{}", check.name, check.subject),
        passed: check.passed,
        detail: check.detail.clone(),
    }
}

fn recorded_slice(check: &Check) -> RecordedCheck {
    let id = serde_json::to_value(check.id).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
    RecordedCheck { id: format!("slice.{id}"), passed: check.passed, detail: check.detail.clone() }
}

/// The package a person opens in Bambu Studio embeds project settings. They
/// must be the settings the verified slice actually used, or the handoff would
/// print differently from what was checked.
fn handoff_matches_slice(template: &Value, spec: &ValidSignSpec, report: &SliceReport) -> RecordedCheck {
    let Some(effective) = &report.effective else {
        return RecordedCheck { id: "handoff.settings_match_slice".into(), passed: false, detail: "no effective settings exported".into() };
    };
    let embedded = |key: &str| template.get(key).cloned().unwrap_or(Value::Null);
    let mut mismatches = Vec::new();
    let mut expect = |key: &str, embedded: Value, effective: Value| {
        if embedded != effective {
            mismatches.push(format!("{key}: package {embedded}, slice {effective}"));
        }
    };
    expect("printer_settings_id", embedded("printer_settings_id"), json!(effective.printer_settings_id));
    expect("print_settings_id", embedded("print_settings_id"), json!(effective.print_settings_id));
    expect("filament_settings_id", embedded("filament_settings_id"), json!(effective.filament_settings_id));
    expect("layer_height", embedded("layer_height"), json!(effective.layer_height));
    expect(
        "enable_prime_tower",
        embedded("enable_prime_tower"),
        json!(if effective.enable_prime_tower { "1" } else { "0" }),
    );
    let expected_colours: Vec<String> = spec.slot_colours().into_iter().collect();
    let effective_colours: Vec<String> = effective.filament_colour.iter().map(|c| c.to_uppercase()).collect();
    if expected_colours != effective_colours {
        mismatches.push(format!("filament_colour: spec {expected_colours:?}, slice {effective_colours:?}"));
    }
    RecordedCheck {
        id: "handoff.settings_match_slice".into(),
        passed: mismatches.is_empty(),
        detail: if mismatches.is_empty() {
            "package settings and colors match the verified slice".into()
        } else {
            mismatches.join("; ")
        },
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;
    use crate::fabrication::revisions::{Approval, BuildState};

    const FIXTURE: &str = include_str!("../../tests/fixtures/signs/synthetic-back-shortly.json");

    fn app_state(dir: &Path) -> AppState {
        let state = AppState::default();
        *state.db.lock().expect("db lock") = Some(crate::database::init_db(&dir.join("test.db")).expect("init db"));
        state
    }

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("fixture json")
    }

    fn claim(state: &AppState, key: &str) -> SignRevision {
        let build = NewBuild {
            lineage_id: None,
            title: "Back shortly".into(),
            spec: fixture(),
            spec_sha256: Sha256Hex::of_bytes(key.as_bytes()),
            build_key: Sha256Hex::of_bytes(key.as_bytes()),
            requested_by: Actor::Human,
        };
        match with_db(state, |conn| revisions::claim_build(conn, build)).expect("claim") {
            BuildClaim::Started(revision) => revision,
            BuildClaim::Existing(revision) => panic!("expected a new build, got {}", revision.id),
        }
    }

    /// A partial directory as the pipeline leaves it, and artifacts that pass every check.
    fn staged(partial: &Path, final_dir: &Path) -> Artifacts {
        fs::create_dir_all(partial).expect("partial dir");
        fs::write(partial.join("sign.3mf"), b"package").expect("package");
        Artifacts {
            revision_dir: final_dir.to_path_buf(),
            package_path: final_dir.join("sign.3mf"),
            package_sha256: Sha256Hex::of_bytes(b"package"),
            preview_path: final_dir.join("preview.png"),
            slice_dir: final_dir.join("slice"),
            gcode_sha256: Sha256Hex::of_bytes(b"gcode"),
            slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "02.08.00.05".into() },
            effective_settings: Value::Null,
            checks: vec![RecordedCheck { id: "slice.slice_succeeded".into(), passed: true, detail: "return_code 0".into() }],
        }
    }

    #[test]
    fn a_placed_build_that_cannot_be_recorded_leaves_no_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let revision = claim(&state, "a");
        let id = revision.id.to_string();
        let (partial, final_dir) = (workspace.partial_dir(&id), workspace.final_dir(&id));
        let artifacts = staged(&partial, &final_dir);
        // The database refuses the result after the rename, as a full disk would.
        with_db(&state, |conn| {
            Ok(conn.execute_batch(
                "CREATE TEMP TRIGGER finish_fails BEFORE UPDATE OF build_status ON sign_revisions
                 WHEN NEW.build_status = 'verified' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
            )?)
        })
        .expect("trigger");

        let result = UnfinishedBuild::new(&state, &revision.id, &partial, &final_dir).settle(artifacts);
        assert!(result.is_err());
        assert!(!final_dir.exists(), "the placed directory is removed with the failed build");
        assert!(!partial.exists());
        let recorded = with_db(&state, |conn| revisions::get(conn, &revision.id)).expect("get");
        assert!(matches!(recorded.build, BuildState::Failed { artifacts: None, .. }));
    }

    #[test]
    fn startup_removes_directories_of_interrupted_builds_and_keeps_verified_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));

        let verified = claim(&state, "verified");
        let id = verified.id.to_string();
        let (partial, verified_dir) = (workspace.partial_dir(&id), workspace.final_dir(&id));
        let finished = UnfinishedBuild::new(&state, &verified.id, &partial, &verified_dir)
            .settle(staged(&partial, &verified_dir))
            .expect("settle");
        assert!(matches!(finished.build, BuildState::Verified { .. }));

        // The app stopped after the rename but before the result was recorded.
        let interrupted = claim(&state, "interrupted");
        let id = interrupted.id.to_string();
        let (partial, interrupted_dir) = (workspace.partial_dir(&id), workspace.final_dir(&id));
        staged(&partial, &interrupted_dir);
        fs::rename(&partial, &interrupted_dir).expect("rename");
        fs::create_dir_all(workspace.partial_dir("leftover")).expect("partial dir");

        let cleanup = reconcile_startup(&state, &workspace).expect("reconcile");
        assert_eq!(cleanup, StartupCleanup { interrupted: 1, removed_dirs: 2 });
        assert!(!interrupted_dir.exists(), "the interrupted build's directory is removed");
        assert!(verified_dir.join("sign.3mf").exists(), "the verified build's directory is kept");
        let recorded = with_db(&state, |conn| revisions::get(conn, &interrupted.id)).expect("get");
        assert!(matches!(recorded.build, BuildState::Failed { ref reason, artifacts: None } if reason.starts_with("interrupted")));
        assert_eq!(workspace.remove_partials().expect("scan"), 0);
    }

    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn builds_verifies_reuses_and_refuses_agent_approval() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let steps = RefCell::new(Vec::new());
        let request = || BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Agent };

        let first = build_sign(&state, &workspace, request(), &|s| steps.borrow_mut().push(s), &|| false).expect("build");
        let artifacts = first.revision.artifacts().expect("artifacts").clone();
        for check in &artifacts.checks {
            println!("{} {} {}", if check.passed { "PASS" } else { "FAIL" }, check.id, check.detail);
        }
        assert!(matches!(first.revision.build, BuildState::Verified { .. }), "every check passes");
        assert_eq!(
            *steps.borrow(),
            [BuildStep::SpecValidated, BuildStep::GeometryBuilt, BuildStep::PackageWritten, BuildStep::Sliced, BuildStep::Verified]
        );
        assert!(fs::metadata(&artifacts.package_path).expect("package").permissions().readonly(), "package is read-only");
        assert_eq!(Sha256Hex::of_file(&artifacts.package_path).expect("hash"), artifacts.package_sha256);
        assert_eq!(workspace.remove_partials().expect("scan"), 0, "no partial directory left behind");

        let again = build_sign(&state, &workspace, request(), &|_| {}, &|| false).expect("rebuild");
        assert!(again.reused, "identical request reuses the revision");
        assert_eq!(again.revision.id, first.revision.id);

        let refused = with_db(&state, |conn| revisions::approve(conn, &first.revision.id, &artifacts.package_sha256, Actor::Agent));
        assert!(matches!(refused, Err(BuildError::Revision(RevisionError::HumanOnly(_)))));
        let approved = with_db(&state, |conn| revisions::approve(conn, &first.revision.id, &artifacts.package_sha256, Actor::Human))
            .expect("human approves");
        assert!(matches!(approved.approval, Approval::Approved { .. }));
        println!("revision {} package {}", first.revision.id, artifacts.package_sha256);
    }

    #[test]
    fn a_missing_bambu_studio_tells_the_person_to_choose_one_in_settings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let gone = dir.path().join("BambuStudio-02.08.02.61/BambuStudio.app");
        {
            let guard = state.db.lock().expect("db lock");
            let conn = guard.as_ref().expect("db");
            crate::database::upsert_setting(conn, "bambu_studio.path", gone.to_str().expect("utf-8")).expect("store choice");
        }

        let request = BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Human };
        let err = build_sign(&state, &workspace, request, &|_| {}, &|| false)
            .expect_err("build fails without Bambu Studio (BAMBU_STUDIO_CLI, if set, overrides the stored choice)");
        let message = err.to_string();
        assert!(message.contains(&gone.display().to_string()), "{message}");
        assert!(message.contains("choose it in Settings > Bambu Studio"), "{message}");
        assert!(message.contains(bambu::DOWNLOAD_URL), "{message}");
        assert!(revisions_of(&state).is_empty(), "no revision is recorded");
    }

    fn revisions_of(state: &AppState) -> Vec<SignRevision> {
        with_db(state, |conn| revisions::list_recent(conn, 50)).expect("list")
    }

    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn identical_concurrent_requests_wait_and_share_one_verified_revision() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                let request = BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Human };
                let claimed = claimed_tx.clone();
                build_sign(&state, &workspace, request, &move |step| {
                    if step == BuildStep::GeometryBuilt {
                        let _ = claimed.send(());
                    }
                }, &|| false)
            });
            claimed_rx.recv().expect("first build claimed its revision");
            let second = scope.spawn(|| {
                let request = BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Agent };
                build_sign(&state, &workspace, request, &|_| {}, &|| false)
            });
            (first.join().expect("first thread"), second.join().expect("second thread"))
        });
        let (first, second) = (first.expect("first build"), second.expect("second build"));
        assert!(!first.reused && second.reused, "the second request reused the first build");
        assert_eq!(first.revision.id, second.revision.id);
        assert!(matches!(second.revision.build, BuildState::Verified { .. }), "the waiting request saw a finished build");
        assert_eq!(revisions_of(&state).len(), 1, "exactly one revision");
    }

    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn a_request_waiting_on_a_build_that_fails_builds_its_own() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let cancel_first = std::sync::atomic::AtomicBool::new(false);
        let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                let request = BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Human };
                let claimed = claimed_tx.clone();
                build_sign(&state, &workspace, request, &move |step| {
                    if step == BuildStep::GeometryBuilt {
                        let _ = claimed.send(());
                    }
                }, &|| cancel_first.load(std::sync::atomic::Ordering::SeqCst))
            });
            claimed_rx.recv().expect("first build claimed its revision");
            let second = scope.spawn(|| {
                let request = BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Agent };
                build_sign(&state, &workspace, request, &|_| {}, &|| false)
            });
            std::thread::sleep(SETTLE_POLL * 2);
            cancel_first.store(true, std::sync::atomic::Ordering::SeqCst);
            (first.join().expect("first thread"), second.join().expect("second thread"))
        });
        assert!(matches!(first, Err(BuildError::Cancelled)));
        let second = second.expect("second build");
        assert!(!second.reused, "a failed build is retried, not reused");
        assert!(matches!(second.revision.build, BuildState::Verified { .. }));
        let all = revisions_of(&state);
        assert_eq!(all.len(), 2);
        assert_eq!(all.iter().filter(|r| matches!(r.build, BuildState::Failed { .. })).count(), 1);
    }

    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn a_panic_mid_build_fails_the_revision_and_a_retry_starts_fresh() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let request = BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Human };
            build_sign(&state, &workspace, request, &|step| assert_ne!(step, BuildStep::PackageWritten, "simulated crash"), &|| false)
        }));
        assert!(panicked.is_err());
        let after_panic = revisions_of(&state);
        assert!(matches!(&after_panic[0].build, BuildState::Failed { reason, .. } if reason == "build panicked"));
        assert_eq!(workspace.remove_partials().expect("scan"), 0, "partial directory removed");

        let retry = build_sign(&state, &workspace, BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Human }, &|_| {}, &|| false)
            .expect("retry");
        assert!(!retry.reused);
        assert!(matches!(retry.revision.build, BuildState::Verified { .. }));
    }

    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn cancelling_records_a_failed_revision_and_leaves_no_partial_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let cancel = Cell::new(false);
        let result = build_sign(
            &state,
            &workspace,
            BuildRequest { spec: fixture(), lineage_id: None, actor: Actor::Human },
            &|step| cancel.set(step == BuildStep::GeometryBuilt),
            &|| cancel.get(),
        );
        assert!(matches!(result, Err(BuildError::Cancelled)));
        let listed = with_db(&state, |conn| revisions::list_recent(conn, 10)).expect("list");
        assert!(matches!(&listed[0].build, BuildState::Failed { reason, .. } if reason == "build cancelled"));
        assert_eq!(workspace.remove_partials().expect("scan"), 0);
    }
}
