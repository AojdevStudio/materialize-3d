//! Application actions shared by every caller: GUI commands, the in-app agent's
//! tools, and external MCP clients. Policy (for example, only people approve)
//! lives in the functions below and the modules they call, never in a caller.
//!
//! Model-driven callers hold only a [`RequestActions`] trait object. Approving,
//! exporting, and recording a print are inherent methods of [`Actions`] that
//! take a [`HumanActor`], which only the GUI commands in [`gui`] can create.

pub(crate) mod gui;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

pub use gui::HumanActor;

use crate::fabrication::checks::CheckId;
use crate::fabrication::kind::{self, BuildControl, KindDriver};
use crate::fabrication::pipeline::{self, BuildError, BuildOutcome, BuildRequest, Workspace};
use crate::fabrication::revisions::{self, Actor, ExportFormat, LineageId, Revision, RevisionId, Sha256Hex};
use crate::state::{AppState, PrinterState};

/// Sent with a revision id whenever a revision changes.
pub const DESIGNS_CHANGED: &str = "designs:changed";
/// Asks the UI to show one revision.
pub const DESIGNS_OPEN: &str = "designs:open";

#[derive(Debug, thiserror::Error)]
pub enum ActionError {
    #[error(transparent)]
    Build(#[from] BuildError),
    #[error(transparent)]
    Revision(#[from] revisions::RevisionError),
    #[error("{0}")]
    State(String),
}

/// Delivers an app event to the UI. A closed window is not an error, so
/// delivery failures are logged by the sink and never fail an action.
/// The running app sends events through [`gui::app_events`]; tests capture them.
pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Who asked for a build through [`RequestActions`]: never a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestActor {
    /// The in-app agent.
    Agent,
    /// An external agent over MCP.
    ExternalMcp,
}

impl From<RequestActor> for Actor {
    fn from(requester: RequestActor) -> Self {
        match requester {
            RequestActor::Agent => Actor::Agent,
            RequestActor::ExternalMcp => Actor::ExternalMcp,
        }
    }
}

/// What any non-human caller may request: the in-app agent and MCP hold this
/// trait object only. There is no way to approve, export, or record a print
/// result through it; those take a [`HumanActor`].
///
/// [`Actions`] implements it for the running app; tests substitute the build
/// pipeline without a window.
///
/// A model-driven caller can read through it:
///
/// ```
/// # use std::sync::Arc;
/// # use materialize_3d_lib::actions::RequestActions;
/// fn list_from_a_model(actions: Arc<dyn RequestActions>) {
///     let _ = actions.list(20);
/// }
/// ```
///
/// but cannot approve:
///
/// ```compile_fail,E0599
/// # use std::sync::Arc;
/// # use materialize_3d_lib::actions::RequestActions;
/// fn approve_from_a_model(actions: Arc<dyn RequestActions>) {
///     let _ = actions.approve(todo!(), "revision", String::new(), Default::default());
/// }
/// ```
///
/// It builds as a model:
///
/// ```
/// # use std::sync::Arc;
/// # use materialize_3d_lib::actions::{RequestActions, RequestActor};
/// # use materialize_3d_lib::fabrication::kind::BuildControl;
/// fn build_as_a_model(actions: Arc<dyn RequestActions>) {
///     let control = BuildControl::new(&|_| {}, &|| false);
///     let _ = actions.build("sign", serde_json::json!({}), None, RequestActor::Agent, &control);
/// }
/// ```
///
/// but cannot build as a person:
///
/// ```compile_fail,E0308
/// # use std::sync::Arc;
/// # use materialize_3d_lib::actions::RequestActions;
/// # use materialize_3d_lib::fabrication::kind::BuildControl;
/// # use materialize_3d_lib::fabrication::revisions::Actor;
/// fn build_as_a_person(actions: Arc<dyn RequestActions>) {
///     let control = BuildControl::new(&|_| {}, &|| false);
///     let _ = actions.build("sign", serde_json::json!({}), None, Actor::Human, &control);
/// }
/// ```
pub trait RequestActions: Send + Sync + 'static {
    /// Blocking; see [`Actions::build`]. The revision records `requester`
    /// as `requested_by`, which can never be a person through this trait.
    fn build(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError>;
    fn list(&self, limit: u32) -> Result<Vec<Revision>, ActionError>;
    fn get(&self, id: &str) -> Result<Revision, ActionError>;
    fn show(&self, id: &str) -> Result<(), ActionError>;
    fn printer_status(&self) -> Result<PrinterState, ActionError>;
    /// The kinds this app can build now, in registry order: `part` only with a
    /// verified CAD runtime. See [`Actions::kinds`].
    fn kinds(&self) -> Vec<&'static dyn KindDriver>;
}

#[derive(Clone)]
pub struct Actions {
    emit: EventSink,
    state: Arc<AppState>,
    workspace: Workspace,
}

impl Actions {
    /// `emit` delivers [`DESIGNS_CHANGED`] and [`DESIGNS_OPEN`]; no Tauri runtime is needed.
    pub fn new(emit: EventSink, state: Arc<AppState>, workspace: Workspace) -> Self {
        Self { emit, state, workspace }
    }

    fn notify(&self, id: &RevisionId) {
        (self.emit)(DESIGNS_CHANGED, Value::String(id.to_string()));
    }

    /// Builds a spec of the registered `kind`. Blocking: geometry and slicing
    /// run on the calling thread. Async callers use `spawn_blocking`.
    pub fn build(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: Option<&str>,
        actor: Actor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        let lineage_id = lineage_id.map(LineageId::parse).transpose()?;
        let request = BuildRequest { kind: kind.to_owned(), spec, lineage_id, actor };
        let outcome = pipeline::build(&self.state, &self.workspace, request, control)?;
        self.notify(&outcome.revision.id);
        Ok(outcome)
    }

    /// The registered kinds this app can build now. `part` drops out when the
    /// CAD runtime is missing or failed verification; signs need nothing.
    pub fn kinds(&self) -> Vec<&'static dyn KindDriver> {
        kind::available(&self.workspace.kernel_context())
    }

    /// The newest revisions of every design, newest first.
    pub fn list(&self, limit: u32) -> Result<Vec<Revision>, ActionError> {
        Ok(pipeline::with_db(&self.state, |conn| revisions::list_recent(conn, limit))?)
    }

    /// Every revision of one design, newest first.
    pub fn lineage(&self, lineage_id: &str) -> Result<Vec<Revision>, ActionError> {
        let lineage = LineageId::parse(lineage_id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::list_lineage(conn, &lineage))?)
    }

    /// Re-hashes an approved package first, so a changed file reads as void.
    pub fn get(&self, id: &str) -> Result<Revision, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::check_integrity(conn, &id))?)
    }

    pub fn preview_png(&self, id: &str) -> Result<Vec<u8>, ActionError> {
        let revision = self.get(id)?;
        let artifacts = revision.artifacts().ok_or_else(|| ActionError::State("this revision has no preview".into()))?;
        std::fs::read(&artifacts.files().preview_path).map_err(|e| ActionError::State(e.to_string()))
    }

    /// Asks the UI to show a revision. Agents use this to hand a result to a person.
    pub fn show(&self, id: &str) -> Result<(), ActionError> {
        let id = RevisionId::parse(id)?;
        (self.emit)(DESIGNS_OPEN, serde_json::json!({ "revisionId": id.as_str() }));
        Ok(())
    }

    /// Approves the package a person saw, identified by its hash, with the
    /// warnings they were shown. `revisions::approve` checks the actor again,
    /// so the rule holds in both the types and the transition, and refuses
    /// warnings that are not exactly the build's.
    pub fn approve(
        &self,
        who: &HumanActor,
        id: &str,
        package_sha256: String,
        acknowledged_warnings: BTreeSet<CheckId>,
    ) -> Result<Revision, ActionError> {
        let id = RevisionId::parse(id)?;
        let expected = Sha256Hex::try_from(package_sha256)?;
        let revision = pipeline::with_db(&self.state, |conn| {
            revisions::approve(conn, &id, &expected, &acknowledged_warnings, who.actor())
        })?;
        self.notify(&revision.id);
        Ok(revision)
    }

    /// Writes what a person approved to `destination`, in `format`: the print
    /// package, or the STEP it carries. Either one comes from the approved
    /// package's bytes, re-hashed first.
    pub fn export(&self, _who: &HumanActor, id: &str, format: ExportFormat, destination: &Path) -> Result<PathBuf, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::export(conn, &id, format, destination))?)
    }

    pub fn record_print_result(
        &self,
        who: &HumanActor,
        id: &str,
        passed: bool,
        note: &str,
    ) -> Result<Revision, ActionError> {
        let id = RevisionId::parse(id)?;
        let revision =
            pipeline::with_db(&self.state, |conn| revisions::record_print_result(conn, &id, passed, note, who.actor()))?;
        self.notify(&revision.id);
        Ok(revision)
    }

    pub fn printer_status(&self) -> Result<PrinterState, ActionError> {
        self.state
            .printer
            .lock()
            .map(|printer| printer.clone())
            .map_err(|e| ActionError::State(format!("printer state lock: {e}")))
    }
}

impl RequestActions for Actions {
    fn build(
        &self,
        kind: &str,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        control: &BuildControl<'_>,
    ) -> Result<BuildOutcome, ActionError> {
        Actions::build(self, kind, spec, lineage_id, requester.into(), control)
    }

    fn list(&self, limit: u32) -> Result<Vec<Revision>, ActionError> {
        Actions::list(self, limit)
    }

    fn get(&self, id: &str) -> Result<Revision, ActionError> {
        Actions::get(self, id)
    }

    fn show(&self, id: &str) -> Result<(), ActionError> {
        Actions::show(self, id)
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Actions::printer_status(self)
    }

    fn kinds(&self) -> Vec<&'static dyn KindDriver> {
        Actions::kinds(self)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn actions_emit_through_the_sink_they_are_given_without_a_tauri_app() {
        let dir = tempfile::tempdir().expect("tempdir");
        let emitted = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let sink: EventSink = Arc::new({
            let emitted = emitted.clone();
            move |event, payload| emitted.lock().expect("emitted").push((event.to_owned(), payload))
        });
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let actions = Actions::new(sink, Arc::new(AppState::default()), workspace);

        let id = "7d9f3c1e-2b4a-4c8e-9f10-123456789abc";
        actions.show(id).expect("show");

        assert_eq!(*emitted.lock().expect("emitted"), [(DESIGNS_OPEN.to_owned(), serde_json::json!({ "revisionId": id }))]);
    }

    fn kind_ids(actions: &Actions) -> Vec<&'static str> {
        RequestActions::kinds(actions).iter().map(|kind| kind.id().as_str()).collect()
    }

    /// Without a verified CAD runtime `part` is not offered; signs are.
    #[test]
    fn part_is_absent_from_kinds_when_the_runtime_is_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache"));
        let actions = Actions::new(Arc::new(|_, _| {}), Arc::new(AppState::default()), workspace.clone());
        assert_eq!(kind_ids(&actions), ["sign"], "no runtime is bundled beside a test binary");
        let actions = Actions::new(Arc::new(|_, _| {}), Arc::new(AppState::default()), workspace.with_cad_runtime(None));
        assert_eq!(kind_ids(&actions), ["sign"]);
    }

    /// A runtime directory whose image does not match the compiled-in pins
    /// never becomes a runtime, so `part` stays absent.
    #[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
    #[test]
    fn part_is_absent_from_kinds_when_the_runtime_fails_verification() {
        use crate::fabrication::cad_worker::{CadRuntime, MicroVmConfig, RuntimeUnavailable};
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vmlinux", "rootfs.img", "job.img"] {
            std::fs::write(dir.path().join(name), b"not the pinned image").expect("write");
        }
        let config = MicroVmConfig { qemu: "qemu-system-x86_64".into() };
        let runtime = CadRuntime::linux_microvm(config, dir.path());
        assert!(matches!(runtime, Err(RuntimeUnavailable::Unverified(_))), "{runtime:?}");
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache")).with_cad_runtime(runtime.ok());
        let actions = Actions::new(Arc::new(|_, _| {}), Arc::new(AppState::default()), workspace);
        assert_eq!(kind_ids(&actions), ["sign"]);
    }
}
