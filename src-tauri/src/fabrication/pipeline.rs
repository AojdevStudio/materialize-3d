//! `build`: one spec of a registered kind in, one verified (or failed)
//! revision out.
//!
//! GUI commands, the in-app agent, and external MCP callers all call
//! [`build`]; only the `actor` differs. The kind's [`KindDriver`] builds and
//! certifies the model; packaging, slicing, slice verification, and recording
//! are shared here. The pipeline never holds the database lock while geometry
//! or slicing runs, writes every artifact into a private `.partial-<id>`
//! directory, and renames it into place before the build is recorded. A crash
//! leaves either a complete record or leftovers that [`reconcile_startup`]
//! removes on the next launch.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};

use super::bambu::{self, BambuError, BambuStudio, Check, ResolvedPresets, SliceReport};
use super::cad_worker::{CadRuntime, CadRuntimeSlot};
use super::checks::{self, CheckOutcome, ChecksFailed, PassedChecks};
use super::kind::{self, BuildControl, KernelContext, KernelError, KindDriver, KindId, ObjectNaming, ParsedSpec, SpecError};
use super::model::Palette;
use super::package::{self, PackageError};
use super::printer::{PrinterProfile, P2S_04};
use super::revisions::{
    self, Actor, BuildFiles, BuildId, BuildState, Claim, LineageId, NewRevision, RecordedCheck, Revision, RevisionError,
    Sha256Hex, SlicerIdentity,
};
use super::studio_choice;
use crate::state::AppState;

/// Where builds live on disk, and the CAD runtime script kinds run in.
#[derive(Debug, Clone)]
pub struct Workspace {
    /// One directory per build, named by its id. The folder is still called
    /// `signs/` because recorded artifacts hold absolute paths into it.
    pub builds_dir: PathBuf,
    pub preset_cache: PathBuf,
    cad: CadRuntimeSlot,
}

impl Workspace {
    /// The app's CAD runtime is the one bundled with it, verified once, on
    /// first use.
    pub fn new(app_data_dir: &Path, app_cache_dir: &Path) -> Self {
        Self {
            builds_dir: app_data_dir.join("signs"),
            preset_cache: app_cache_dir.join("bambu-presets"),
            cad: CadRuntimeSlot::bundled(),
        }
    }

    /// The same workspace with `runtime` as its CAD runtime, or with none.
    pub fn with_cad_runtime(self, runtime: Option<CadRuntime>) -> Self {
        Self { cad: CadRuntimeSlot::fixed(runtime), ..self }
    }

    /// What a kernel builds with: the printer and the verified CAD runtime.
    pub fn kernel_context(&self) -> KernelContext {
        KernelContext { printer: P2S_04, runtime: self.cad.get().cloned() }
    }

    fn partial_dir(&self, build: &BuildId) -> PathBuf {
        self.builds_dir.join(format!(".partial-{build}"))
    }

    fn final_dir(&self, build: &BuildId) -> PathBuf {
        self.builds_dir.join(build.as_str())
    }

    /// Removes `.partial-*` directories left by builds that never finished.
    /// Part of [`reconcile_startup`].
    pub fn remove_partials(&self) -> std::io::Result<usize> {
        let entries = match fs::read_dir(&self.builds_dir) {
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
/// rename left a complete-looking `signs/<id>` that no build record refers to, so
/// the directory of every build still recorded as running is removed before
/// the build is marked failed; a crash part way through is finished next launch.
pub fn reconcile_startup(state: &AppState, workspace: &Workspace) -> Result<StartupCleanup, BuildError> {
    let unfinished = with_db(state, |conn| revisions::unfinished_builds(conn))?;
    let mut removed_dirs = 0;
    for build in &unfinished {
        if remove_dir_if_present(&workspace.final_dir(build))? {
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
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum BuildStep {
    SpecValidated,
    GeometryBuilt,
    PackageWritten,
    Sliced,
    Verified,
}

/// Where a failed build stopped. A caller repairing a script reads it beside
/// the error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// The generation guest, running the script.
    Generate,
    /// The inspection guest, normalizing what the script made.
    Inspect,
    /// The app's checks of the model.
    Geometry,
    Slice,
    Handoff,
}

impl std::fmt::Display for Stage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Stage::Generate => "generate",
            Stage::Inspect => "inspect",
            Stage::Geometry => "geometry",
            Stage::Slice => "slice",
            Stage::Handoff => "handoff",
        })
    }
}

#[derive(Debug, Serialize)]
pub struct BuildOutcome {
    pub revision: Revision,
    /// True when nothing ran: the revision already existed, or it uses an
    /// identical build that was already verified.
    pub reused: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error("unknown kind {0:?}; the registered kinds are {}", registered_kinds())]
    UnknownKind(String),
    /// The kind is registered but cannot build in this app, such as `part`
    /// without a verified CAD runtime.
    #[error("{0} is unavailable: this app has no verified CAD runtime")]
    Unavailable(KindId),
    #[error(transparent)]
    Spec(#[from] SpecError),
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
    /// A bounded error from a script build, and where it stopped. The text is
    /// what the build records as its failure.
    #[error("{stage}: {error}")]
    Stage { stage: Stage, error: String },
}

impl From<BambuError> for BuildError {
    fn from(err: BambuError) -> Self {
        match err {
            BambuError::Cancelled => BuildError::Cancelled,
            other => BuildError::Failed(other.to_string()),
        }
    }
}

impl From<KernelError> for BuildError {
    fn from(err: KernelError) -> Self {
        match err {
            KernelError::Cancelled => BuildError::Cancelled,
            KernelError::Failed(reason) => BuildError::Failed(reason),
            KernelError::Stage { stage, error } => BuildError::Stage { stage, error },
        }
    }
}

fn registered_kinds() -> String {
    kind::KINDS.iter().map(|kind| kind.id().as_str()).collect::<Vec<_>>().join(", ")
}

impl From<PackageError> for BuildError {
    fn from(err: PackageError) -> Self {
        BuildError::Failed(err.to_string())
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
    /// A registered kind's id, such as `sign`.
    pub kind: String,
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

/// Builds, slices, and verifies a spec of a registered kind. Repeating the
/// latest revision returns it, and a spec that builds the same as a verified
/// build becomes a revision on that build, both without doing any work. An
/// unknown kind, a validation error, or a missing slicer fails before any
/// revision is recorded; anything later is recorded on the build as a failure.
pub fn build(
    state: &AppState,
    workspace: &Workspace,
    request: BuildRequest,
    control: &BuildControl<'_>,
) -> Result<BuildOutcome, BuildError> {
    let driver = kind::find(&request.kind).ok_or_else(|| BuildError::UnknownKind(request.kind.clone()))?;
    let ctx = workspace.kernel_context();
    if !driver.available(&ctx) {
        return Err(BuildError::Unavailable(driver.id()));
    }
    let parsed = driver.parse(request.spec.clone(), &ctx.printer)?;
    control.report(BuildStep::SpecValidated);

    let chosen = studio_choice::chosen(state).map_err(BuildError::Failed)?;
    let studio = BambuStudio::locate(chosen.as_deref()).map_err(BuildError::Studio)?;
    let template: Value = serde_json::from_str(ctx.printer.template)
        .map_err(|e| BuildError::Failed(format!("project settings template: {e}")))?;
    let presets = bambu::resolve_presets(&studio, &template_selection(&template)?, &workspace.preset_cache)
        .map_err(BuildError::Slicer)?;
    let key_inputs = driver.key_inputs(&ctx);
    let request = NewRevision {
        lineage_id: request.lineage_id,
        kind: parsed.kind(),
        title: parsed.title().to_owned(),
        spec: request.spec,
        spec_sha256: parsed.spec_sha256().clone(),
        build_key: build_key(&parsed, &key_inputs, &presets.app_version, &presets.profile_version, ctx.printer.template),
        check_plan: parsed.plan().id(),
        requested_by: request.actor,
    };
    // An identical build already running is awaited, never reported as done:
    // once it settles, a verified result is reused and a failed one is retried.
    let revision = loop {
        match with_db(state, |conn| revisions::claim(conn, &request))? {
            Claim::Started(revision) => break revision,
            Claim::Reused(revision) => return Ok(BuildOutcome { revision, reused: true }),
            Claim::Busy(build) => wait_until_settled(state, &build, control)?,
        }
    };

    let build = &revision.build_id;
    let (partial, final_dir) = (workspace.partial_dir(build), workspace.final_dir(build));
    let mut unfinished = UnfinishedBuild::new(state, build, &partial, &final_dir);
    let object_name = driver.naming().object_name(parsed.title(), &revision.build_key);
    let staged = Staged {
        template: &template,
        studio: &studio,
        presets: &presets,
        partial: &partial,
        final_dir: &final_dir,
        object_name: &object_name,
    };
    let (files, verdict) = run_pipeline(driver, &parsed, &ctx, &staged, control).map_err(|err| unfinished.fail(err))?;
    unfinished.settle(files, verdict)?;
    let finished = with_db(state, |conn| revisions::get(conn, &revision.id))?;
    if matches!(finished.build, BuildState::Verified { .. }) {
        control.report(BuildStep::Verified);
    }
    Ok(BuildOutcome { revision: finished, reused: false })
}

/// Hash of every input that determines a build's output: the kind's tag, the
/// validated spec, the slicer and profile versions, the project template, and
/// the kind's own inputs ([`KindDriver::key_inputs`]), which a kind without
/// any leaves out so its keys stay what they were.
fn build_key(parsed: &ParsedSpec, key_inputs: &[String], app_version: &str, profile_version: &str, template: &str) -> Sha256Hex {
    let shared = [parsed.tag(), parsed.spec_sha256().as_str(), app_version, profile_version, template];
    let inputs: Vec<&str> = shared.into_iter().chain(key_inputs.iter().map(String::as_str)).collect();
    Sha256Hex::of_bytes(inputs.join("\n").as_bytes())
}

const SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(250);

fn wait_until_settled(state: &AppState, build: &BuildId, control: &BuildControl<'_>) -> Result<(), BuildError> {
    loop {
        if control.is_cancelled() {
            return Err(BuildError::Cancelled);
        }
        if with_db(state, |conn| revisions::build_settled(conn, build))? {
            return Ok(());
        }
        std::thread::sleep(SETTLE_POLL);
    }
}

/// A claimed build that has not been recorded as finished. Dropping it before
/// the build settles, through an error or a panic, marks the build failed and
/// removes its directory, so no build stays `building` and no directory
/// outlives a failed build while the app keeps running.
struct UnfinishedBuild<'a> {
    state: &'a AppState,
    build: &'a BuildId,
    partial: &'a Path,
    final_dir: &'a Path,
    /// The partial directory has been renamed to `final_dir`.
    placed: bool,
    settled: bool,
}

impl<'a> UnfinishedBuild<'a> {
    fn new(state: &'a AppState, build: &'a BuildId, partial: &'a Path, final_dir: &'a Path) -> Self {
        Self { state, build, partial, final_dir, placed: false, settled: false }
    }

    /// Moves the finished partial directory into place and records the build:
    /// verified only from the plan's proof, failed with its evidence otherwise.
    fn settle(mut self, files: BuildFiles, verdict: Verdict) -> Result<(), BuildError> {
        fs::rename(self.partial, self.final_dir).map_err(|err| self.fail(err.into()))?;
        self.placed = true;
        with_db(self.state, |conn| match verdict {
            Verdict::Passed(passed) => revisions::finish_verified(conn, self.build, files, &passed),
            Verdict::Failed(outcomes) => revisions::finish_failed(conn, self.build, files, &outcomes),
        })
        .map_err(|err| self.fail(err))?;
        self.settled = true;
        Ok(())
    }

    fn fail(&mut self, err: BuildError) -> BuildError {
        self.record_failure(&err.to_string());
        err
    }

    fn record_failure(&mut self, reason: &str) {
        self.settled = true;
        let _ = fs::remove_dir_all(self.partial);
        match with_db(self.state, |conn| revisions::fail_build(conn, self.build, reason)) {
            // The build moved from building to failed, so it has no artifacts
            // on record and nothing refers to its placed directory.
            Ok(()) if self.placed => {
                if let Err(err) = remove_dir_if_present(self.final_dir) {
                    log::error!("build {}: could not remove {}: {err}", self.build, self.final_dir.display());
                }
            }
            Ok(()) => {}
            // Still `building` if the database is failing; startup reconciliation
            // removes the directory and records the failure next launch.
            Err(err) => log::error!("build {}: could not record failure ({reason}): {err}", self.build),
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

/// What a finished build's checks proved.
enum Verdict {
    /// Every planned blocking check passed; the build is recorded as verified
    /// from this, with any failed advisory checks as warnings.
    Passed(PassedChecks),
    /// Every planned check ran and at least one blocking check failed. Holds
    /// every outcome, in plan order.
    Failed(Vec<CheckOutcome>),
}

/// Where one build's shared stages read and write.
struct Staged<'a> {
    template: &'a Value,
    studio: &'a BambuStudio,
    presets: &'a ResolvedPresets,
    partial: &'a Path,
    final_dir: &'a Path,
    /// What the package names the object ([`KindDriver::naming`]).
    object_name: &'a str,
}

/// Has the kind build and certify its model, then writes and slices the
/// package and judges every planned check. Checks that do not match the plan
/// fail the build outright.
fn run_pipeline(
    driver: &dyn KindDriver,
    parsed: &ParsedSpec,
    ctx: &KernelContext,
    staged: &Staged<'_>,
    control: &BuildControl<'_>,
) -> Result<(BuildFiles, Verdict), BuildError> {
    let Staged { template, studio, presets, partial, final_dir, object_name } = *staged;
    let printer = &ctx.printer;
    let cancelled = || if control.is_cancelled() { Err(BuildError::Cancelled) } else { Ok(()) };
    fs::create_dir_all(partial)?;
    fs::write(partial.join("spec.json"), serde_json::to_vec_pretty(parsed.validated())?)?;

    let prepared = driver.prepare(parsed, ctx, control)?;
    let (checked, plan) = (prepared.checked, &prepared.plan);
    let package = partial.join(format!("{}.3mf", parsed.kind()));
    let info = package::write_package(&checked, object_name, printer, &package)?;
    set_read_only(&package)?;
    fs::write(partial.join("preview.png"), prepared.preview)?;
    control.report(BuildStep::PackageWritten);
    cancelled()?;

    let slice_dir = partial.join("slice");
    let report = bambu::slice_project(studio, presets, &package, &slice_dir, &|| control.is_cancelled())?;
    control.report(BuildStep::Sliced);

    let footprints = bambu::part_footprints(&package)?;
    let slice_checks = match driver.naming() {
        ObjectNaming::Title => bambu::verify(&report, &footprints, presets),
        ObjectNaming::BuildKey => bambu::verify_part(&report, &footprints, presets, object_name),
    };
    let slice = slice_checks.iter().map(slice_outcome).collect();
    let handoff = vec![handoff_matches_slice(template, checked.model().palette(), printer, &report)];
    let verdict = match plan.finish(checked.geometry(), slice, handoff) {
        Ok(passed) => Verdict::Passed(passed),
        Err(ChecksFailed::Failed(outcomes)) => Verdict::Failed(outcomes),
        Err(mismatch @ (ChecksFailed::Mismatch(_) | ChecksFailed::WrongPlan { .. })) => {
            return Err(BuildError::Failed(mismatch.to_string()))
        }
    };
    let outcomes = match &verdict {
        Verdict::Passed(passed) => passed.outcomes(),
        Verdict::Failed(outcomes) => outcomes,
    };
    let checks: Vec<RecordedCheck> = outcomes.iter().map(RecordedCheck::from).collect();
    fs::write(partial.join("checks.json"), serde_json::to_vec_pretty(&checks)?)?;

    let gcode_sha256 = report
        .gcode
        .first()
        .map(|file| Sha256Hex::try_from(file.sha256.clone()))
        .transpose()?
        .ok_or_else(|| BuildError::Failed("slice produced no G-code".into()))?;
    let rebase = |path: &Path| final_dir.join(path.strip_prefix(partial).unwrap_or(path));
    Ok((BuildFiles {
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
    }, verdict))
}

fn set_read_only(path: &Path) -> std::io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

fn slice_outcome(check: &Check) -> CheckOutcome {
    CheckOutcome { id: checks::slice_check_id(check.id), passed: check.passed, detail: check.detail.clone() }
}

/// The package a person opens in Bambu Studio embeds project settings. They
/// must be the settings the verified slice actually used, or the handoff would
/// print differently from what was checked.
fn handoff_matches_slice(template: &Value, palette: &Palette, printer: &PrinterProfile, report: &SliceReport) -> CheckOutcome {
    let id = checks::handoff_settings_match_slice();
    let Some(effective) = &report.effective else {
        return CheckOutcome { id, passed: false, detail: "no effective settings exported".into() };
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
    let expected_colours: Vec<String> = palette.slot_colours(printer);
    let effective_colours: Vec<String> = effective.filament_colour.iter().map(|c| c.to_uppercase()).collect();
    if expected_colours != effective_colours {
        mismatches.push(format!("filament_colour: spec {expected_colours:?}, slice {effective_colours:?}"));
    }
    CheckOutcome {
        id,
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

    use std::collections::BTreeSet;

    use super::*;
    use crate::fabrication::kind::{Kind, KindId};
    use crate::fabrication::kinds::sign::Sign;
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

    fn claim(state: &AppState, key: &str) -> Revision {
        let request = NewRevision {
            lineage_id: None,
            kind: KindId::new("sign"),
            title: "Back shortly".into(),
            spec: fixture(),
            spec_sha256: Sha256Hex::of_bytes(key.as_bytes()),
            build_key: Sha256Hex::of_bytes(key.as_bytes()),
            check_plan: checks::test_support::PLAN,
            requested_by: Actor::Human,
        };
        match with_db(state, |conn| revisions::claim(conn, &request)).expect("claim") {
            Claim::Started(revision) => revision,
            other => panic!("expected a new build, got {other:?}"),
        }
    }

    fn get(state: &AppState, revision: &Revision) -> Revision {
        with_db(state, |conn| revisions::get(conn, &revision.id)).expect("get")
    }

    /// Proof that the one check `staged` records passed.
    fn passed() -> Verdict {
        Verdict::Passed(checks::test_support::passed(&[checks::slice_check_id(bambu::CheckId::SliceSucceeded)]))
    }

    /// A partial directory as the pipeline leaves it, and the files it records.
    fn staged(partial: &Path, final_dir: &Path) -> BuildFiles {
        fs::create_dir_all(partial).expect("partial dir");
        fs::write(partial.join("sign.3mf"), b"package").expect("package");
        BuildFiles {
            revision_dir: final_dir.to_path_buf(),
            package_path: final_dir.join("sign.3mf"),
            package_sha256: Sha256Hex::of_bytes(b"package"),
            preview_path: final_dir.join("preview.png"),
            slice_dir: final_dir.join("slice"),
            gcode_sha256: Sha256Hex::of_bytes(b"gcode"),
            slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "02.08.00.05".into() },
            effective_settings: Value::Null,
        }
    }

    /// The build key formula is the one sign builds used before kinds existed,
    /// with the sign's tag where the pipeline version was, so pre-kind sign
    /// builds are found by key.
    #[test]
    fn the_sign_build_key_is_the_pre_kind_formula() {
        let parsed = Kind::<Sign>::NEW.parse(fixture(), &P2S_04).expect("parse");
        let before = ["sign-pipeline-1", "8251927fe35f701ab5275eba7fb540f100b08776616b5c20a9e9db88d4d4c0eb", "02.08.02.61", "02.08.00.05", P2S_04.template];
        assert_eq!(build_key(&parsed, &[], "02.08.02.61", "02.08.00.05", P2S_04.template), Sha256Hex::of_bytes(before.join("\n").as_bytes()));
    }

    #[test]
    fn a_placed_build_that_cannot_be_recorded_leaves_no_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let revision = claim(&state, "a");
        let (partial, final_dir) = (workspace.partial_dir(&revision.build_id), workspace.final_dir(&revision.build_id));
        let files = staged(&partial, &final_dir);
        // The database refuses the result after the rename, as a full disk would.
        with_db(&state, |conn| {
            Ok(conn.execute_batch(
                "CREATE TEMP TRIGGER finish_fails BEFORE UPDATE OF build_status ON builds
                 WHEN NEW.build_status = 'verified' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
            )?)
        })
        .expect("trigger");

        let result = UnfinishedBuild::new(&state, &revision.build_id, &partial, &final_dir).settle(files, passed());
        assert!(result.is_err());
        assert!(!final_dir.exists(), "the placed directory is removed with the failed build");
        assert!(!partial.exists());
        assert!(matches!(get(&state, &revision).build, BuildState::Failed { artifacts: None, .. }));
    }

    #[test]
    fn startup_removes_directories_of_interrupted_builds_and_keeps_verified_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));

        let verified = claim(&state, "verified");
        let (partial, verified_dir) = (workspace.partial_dir(&verified.build_id), workspace.final_dir(&verified.build_id));
        UnfinishedBuild::new(&state, &verified.build_id, &partial, &verified_dir)
            .settle(staged(&partial, &verified_dir), passed())
            .expect("settle");
        assert!(matches!(get(&state, &verified).build, BuildState::Verified { .. }));

        // The app stopped after the rename but before the result was recorded.
        let interrupted = claim(&state, "interrupted");
        let build = &interrupted.build_id;
        let (partial, interrupted_dir) = (workspace.partial_dir(build), workspace.final_dir(build));
        staged(&partial, &interrupted_dir);
        fs::rename(&partial, &interrupted_dir).expect("rename");
        fs::create_dir_all(workspace.builds_dir.join(".partial-leftover")).expect("partial dir");

        let cleanup = reconcile_startup(&state, &workspace).expect("reconcile");
        assert_eq!(cleanup, StartupCleanup { interrupted: 1, removed_dirs: 2 });
        assert!(!interrupted_dir.exists(), "the interrupted build's directory is removed");
        assert!(verified_dir.join("sign.3mf").exists(), "the verified build's directory is kept");
        let recorded = get(&state, &interrupted);
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
        let request = || BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Agent };

        let first = build(&state, &workspace, request(), &BuildControl::new(&|s| steps.borrow_mut().push(s), &|| false)).expect("build");
        let artifacts = first.revision.artifacts().expect("artifacts").clone();
        for check in artifacts.checks() {
            println!("{} {} {}", if check.passed { "PASS" } else { "FAIL" }, check.id, check.detail);
        }
        let files = artifacts.files();
        assert!(matches!(first.revision.build, BuildState::Verified { .. }), "every check passes");
        assert_eq!(
            *steps.borrow(),
            [BuildStep::SpecValidated, BuildStep::GeometryBuilt, BuildStep::PackageWritten, BuildStep::Sliced, BuildStep::Verified]
        );
        assert!(fs::metadata(&files.package_path).expect("package").permissions().readonly(), "package is read-only");
        assert_eq!(Sha256Hex::of_file(&files.package_path).expect("hash"), files.package_sha256);
        assert_eq!(workspace.remove_partials().expect("scan"), 0, "no partial directory left behind");

        let again = build(&state, &workspace, request(), &BuildControl::new(&|_| {}, &|| false)).expect("rebuild");
        assert!(again.reused, "identical request reuses the revision");
        assert_eq!(again.revision.id, first.revision.id);

        let none = BTreeSet::new();
        let refused = with_db(&state, |conn| revisions::approve(conn, &first.revision.id, &files.package_sha256, &none, Actor::Agent));
        assert!(matches!(refused, Err(BuildError::Revision(RevisionError::HumanOnly(_)))));
        let approved = with_db(&state, |conn| revisions::approve(conn, &first.revision.id, &files.package_sha256, &none, Actor::Human))
            .expect("human approves");
        assert!(matches!(approved.approval, Approval::Approved { .. }));
        println!("revision {} package {}", first.revision.id, files.package_sha256);
    }

    /// The fixture sign records exactly the 27 checks it recorded before signs
    /// moved onto the shared model, in the same order, on a byte-identical package.
    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn a_fixture_build_records_the_characterized_checks_and_package() {
        let expected: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/signs/characterization.json")).expect("fixture json");
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Human };

        let built = build(&state, &workspace, request, &BuildControl::new(&|_| {}, &|| false)).expect("build");
        assert!(matches!(built.revision.build, BuildState::Verified { .. }), "every check passes");
        let artifacts = built.revision.artifacts().expect("artifacts");
        let ids: Vec<&str> = artifacts.checks().iter().map(|c| c.id.as_str()).collect();
        let want: Vec<&str> = expected["synthetic_back_shortly_check_ids"]
            .as_array()
            .expect("check ids")
            .iter()
            .map(|id| id.as_str().expect("check id"))
            .collect();
        assert_eq!(want.len(), 27);
        assert_eq!(ids, want);
        assert_eq!(artifacts.files().package_sha256.as_str(), expected["packages"]["synthetic-back-shortly"]["sha256"]);
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

        let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Human };
        let err = build(&state, &workspace, request, &BuildControl::new(&|_| {}, &|| false))
            .expect_err("build fails without Bambu Studio (BAMBU_STUDIO_CLI, if set, overrides the stored choice)");
        let message = err.to_string();
        assert!(message.contains(&gone.display().to_string()), "{message}");
        assert!(message.contains("choose it in Settings > Bambu Studio"), "{message}");
        assert!(message.contains(bambu::DOWNLOAD_URL), "{message}");
        assert!(revisions_of(&state).is_empty(), "no revision is recorded");
    }

    fn revisions_of(state: &AppState) -> Vec<Revision> {
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
                let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Human };
                let claimed = claimed_tx.clone();
                let progress = move |step| {
                    if step == BuildStep::GeometryBuilt {
                        let _ = claimed.send(());
                    }
                };
                build(&state, &workspace, request, &BuildControl::new(&progress, &|| false))
            });
            claimed_rx.recv().expect("first build claimed its revision");
            let second = scope.spawn(|| {
                let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Agent };
                build(&state, &workspace, request, &BuildControl::new(&|_| {}, &|| false))
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
                let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Human };
                let claimed = claimed_tx.clone();
                let progress = move |step| {
                    if step == BuildStep::GeometryBuilt {
                        let _ = claimed.send(());
                    }
                };
                let cancelled = || cancel_first.load(std::sync::atomic::Ordering::SeqCst);
                build(&state, &workspace, request, &BuildControl::new(&progress, &cancelled))
            });
            claimed_rx.recv().expect("first build claimed its revision");
            let second = scope.spawn(|| {
                let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Agent };
                build(&state, &workspace, request, &BuildControl::new(&|_| {}, &|| false))
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
            let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Human };
            build(&state, &workspace, request, &BuildControl::new(&|step| assert_ne!(step, BuildStep::PackageWritten, "simulated crash"), &|| false))
        }));
        assert!(panicked.is_err());
        let after_panic = revisions_of(&state);
        assert!(matches!(&after_panic[0].build, BuildState::Failed { reason, .. } if reason == "build panicked"));
        assert_eq!(workspace.remove_partials().expect("scan"), 0, "partial directory removed");

        let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Human };
        let retry = build(&state, &workspace, request, &BuildControl::new(&|_| {}, &|| false))
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
        let request = BuildRequest { kind: "sign".into(), spec: fixture(), lineage_id: None, actor: Actor::Human };
        let progress = |step| cancel.set(step == BuildStep::GeometryBuilt);
        let result = build(&state, &workspace, request, &BuildControl::new(&progress, &|| cancel.get()));
        assert!(matches!(result, Err(BuildError::Cancelled)));
        let listed = with_db(&state, |conn| revisions::list_recent(conn, 10)).expect("list");
        assert!(matches!(&listed[0].build, BuildState::Failed { reason, .. } if reason == "build cancelled"));
        assert_eq!(workspace.remove_partials().expect("scan"), 0);
    }

    /// 60 -> 65 -> 60 with the real slicer: the third request is revision 3 on
    /// revision 1's build, and nothing past spec validation runs for it.
    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn returning_to_an_earlier_spec_reuses_its_build_without_geometry_or_slicing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = app_state(dir.path());
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let tall = |height: u32| {
            let mut spec = fixture();
            spec["height_mm"] = serde_json::json!(height);
            spec
        };
        let request = |spec, lineage_id| BuildRequest { kind: "sign".into(), spec, lineage_id, actor: Actor::Agent };
        let quiet = BuildControl::new(&|_| {}, &|| false);

        let first = build(&state, &workspace, request(tall(210), None), &quiet).expect("first");
        let lineage = first.revision.lineage_id.clone();
        let second = build(&state, &workspace, request(tall(215), Some(lineage.clone())), &quiet).expect("second");
        assert!(matches!(second.revision.build, BuildState::Verified { .. }) && !second.reused);

        let steps = RefCell::new(Vec::new());
        let third = build(&state, &workspace, request(tall(210), Some(lineage)), &BuildControl::new(&|s| steps.borrow_mut().push(s), &|| false))
            .expect("third");
        assert!(third.reused, "nothing was built");
        assert_eq!(*steps.borrow(), [BuildStep::SpecValidated], "no geometry, package, or slice step ran");
        assert_eq!((third.revision.number, third.revision.parent_id.as_ref()), (3, Some(&second.revision.id)));
        assert_eq!(third.revision.build_id, first.revision.build_id);
        assert!(matches!(third.revision.build, BuildState::Verified { .. }));
        assert_eq!(revisions_of(&state).len(), 3);
    }

    /// Slices `package` with the validated Bambu Studio and the P2S presets, as `build` does.
    fn slice_with_real_bambu(dir: &Path, package: &Path) -> (SliceReport, Vec<bambu::PartFootprint>, ResolvedPresets) {
        let studio = BambuStudio::locate(None).expect("a validated Bambu Studio");
        let template: Value = serde_json::from_str(P2S_04.template).expect("template");
        let presets = bambu::resolve_presets(&studio, &template_selection(&template).expect("selection"), &dir.join("cache"))
            .expect("presets");
        let report = bambu::slice_project(&studio, &presets, package, &dir.join("slice"), &|| false).expect("slice");
        (report, bambu::part_footprints(package).expect("footprints"), presets)
    }

    /// A 40 mm slab on a 10 mm post, which Bambu Studio says needs supports. The post is 10 mm, not thinner, because
    /// a 4 mm first layer read 0.989 recall on macOS Bambu Studio, below `slice.layer1_coverage`'s sign-tuned 0.99.
    fn slab_on_a_post() -> checks::CheckedModel {
        use crate::fabrication::checks::{CheckId, CheckPhase, CheckPlan, CheckPlanId};
        use crate::fabrication::model::{Body, Mesh, PrintableModel};
        let cuboid = |lo: [i64; 3], hi: [i64; 3], base: u32| {
            let v: Vec<[i64; 3]> = (0..8)
                .map(|i| [if i & 1 == 0 { lo[0] } else { hi[0] }, if i & 2 == 0 { lo[1] } else { hi[1] }, if i & 4 == 0 { lo[2] } else { hi[2] }])
                .collect();
            let t: Vec<[u32; 3]> = [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]
                .iter()
                .map(|tri| tri.map(|i| i + base))
                .collect();
            (v, t)
        };
        let (mut v, mut t) = cuboid([15_000, 15_000, 0], [25_000, 25_000, 10_000], 0);
        let (sv, st) = cuboid([0, 0, 10_000], [40_000, 40_000, 13_000], 8);
        v.extend(sv);
        t.extend(st);
        let palette = Palette::new(vec!["#FFFFFF".into()], &P2S_04).expect("palette");
        let slot = palette.slot(0).expect("slot");
        let model = PrintableModel::new("Slab on a post".into(), palette, vec![Body { name: "tee".into(), slot, mesh: Mesh::new(v, t).expect("mesh") }])
            .expect("model");
        let id = CheckId::new(CheckPhase::Geometry, "test.tee");
        let plan = CheckPlan::new(CheckPlanId::new("slice-test-1"), vec![id.clone()]).expect("plan");
        plan.certify(model, Vec::new(), vec![CheckOutcome { id, passed: true, detail: String::new() }]).expect("certified")
    }

    /// Bambu Studio's own support warning about a part's app-named object is
    /// advisory; the same warning about an object named by its title, which a
    /// spec could word to look like anything, still fails `slice.no_warnings`.
    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn the_real_slicers_support_warning_is_advisory_only_for_the_app_named_object() {
        let dir = tempfile::tempdir().expect("tempdir");
        let checked = slab_on_a_post();
        let object = ObjectNaming::BuildKey.object_name(checked.model().title(), &Sha256Hex::of_bytes(b"slab"));
        let package = dir.path().join("part.3mf");
        package::write_package(&checked, &object, &P2S_04, &package).expect("package");
        let (report, parts, presets) = slice_with_real_bambu(&dir.path().join("part"), &package);
        let checks = bambu::verify_part(&report, &parts, &presets, &object);
        for check in &checks {
            println!("{} {:?}: {}", if check.passed { "PASS" } else { "FAIL" }, check.id, check.detail);
        }
        let support = checks.iter().find(|c| c.id == bambu::CheckId::SupportWarning).expect("support warning");
        assert!(!support.passed && support.detail.contains(&format!("It seems object {object} has ")), "{support:?}");
        assert!(checks.iter().filter(|c| c.id != bambu::CheckId::SupportWarning).all(|c| c.passed), "nothing else fails");
        assert!(checks::slice_support_warning().is_advisory());

        let titled = dir.path().join("titled.3mf");
        package::write_package(&checked, checked.model().title(), &P2S_04, &titled).expect("package");
        let (report, parts, presets) = slice_with_real_bambu(&dir.path().join("titled"), &titled);
        let checks = bambu::verify_part(&report, &parts, &presets, &object);
        let no_warnings = checks.iter().find(|c| c.id == bambu::CheckId::NoWarnings).expect("no warnings");
        assert!(!no_warnings.passed && no_warnings.detail.contains("It seems object Slab on a post has "), "{no_warnings:?}");
    }

    /// Two objects on one plate that each need supports: `result.json` keeps
    /// one warning, the log keeps both, and both are judged.
    #[test]
    #[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
    fn two_warnings_on_one_plate_both_surface_from_the_real_slicer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bambu/two-support-warnings.3mf");
        let package = dir.path().join("two.3mf");
        fs::copy(&fixture, &package).expect("fixture");
        let (report, parts, presets) = slice_with_real_bambu(dir.path(), &package);
        println!("result.json: {:?}\nlog: {:?}", report.plate_warnings, report.logged_warnings);
        assert_eq!(report.logged_warnings.len(), 2, "both warnings are in the log");
        assert_eq!(report.plate_warnings.iter().filter(|w| !w.message.is_empty()).count(), 1, "result.json keeps one");
        let checks = bambu::verify_part(&report, &parts, &presets, "part-tee");
        let detail = |id| checks.iter().find(|c| c.id == id).map(|c| (c.passed, c.detail.clone())).expect("check");
        let (passed, no_warnings) = detail(bambu::CheckId::NoWarnings);
        assert!(!passed && no_warnings.contains("It seems object part-other has floating cantilever"), "{no_warnings}");
        let (passed, support) = detail(bambu::CheckId::SupportWarning);
        assert!(!passed && support.contains("It seems object part-tee has floating cantilever"), "{support}");
    }
}
