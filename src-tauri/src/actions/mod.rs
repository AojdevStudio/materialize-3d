//! Application actions shared by every caller: GUI commands, the in-app agent's
//! tools, and external MCP clients. Policy (for example, only people approve)
//! lives in the functions below and the modules they call, never in a caller.
//!
//! Model-driven callers hold only a [`RequestActions`] trait object. Approving,
//! exporting, and recording a print are inherent methods of [`Actions`] that
//! take a [`HumanActor`], which only the GUI commands in [`gui`] can create.

pub(crate) mod gui;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

pub use gui::HumanActor;

use crate::fabrication::pipeline::{self, BuildError, BuildOutcome, BuildRequest, BuildStep, Workspace};
use crate::fabrication::revisions::{self, Actor, BuildState, LineageId, RevisionId, Sha256Hex, SignRevision};
use crate::state::{AppState, PrinterState};

pub const SIGNS_CHANGED: &str = "signs:changed";
pub const SIGNS_OPEN: &str = "signs:open";

#[derive(Debug, thiserror::Error)]
pub enum ActionError {
    #[error(transparent)]
    Build(#[from] BuildError),
    #[error(transparent)]
    Revision(#[from] revisions::RevisionError),
    #[error("{0}")]
    State(String),
}

/// A compact view of a revision for agents and lists: enough to reason about
/// and to cite, without effective settings or file paths.
#[derive(Debug, Clone, Serialize)]
pub struct SignSummary {
    pub revision_id: String,
    pub lineage_id: String,
    pub number: u32,
    pub title: String,
    pub build: &'static str,
    pub failure_reason: Option<String>,
    pub checks_passed: usize,
    pub checks_total: usize,
    pub failed_checks: Vec<String>,
    pub package_sha256: Option<String>,
    pub approval: &'static str,
    pub print_validation: &'static str,
    pub requested_by: Actor,
    pub created_at: String,
}

impl From<&SignRevision> for SignSummary {
    fn from(revision: &SignRevision) -> Self {
        let artifacts = revision.artifacts();
        let checks = artifacts.map(|a| a.checks.as_slice()).unwrap_or_default();
        Self {
            revision_id: revision.id.to_string(),
            lineage_id: revision.lineage_id.to_string(),
            number: revision.number,
            title: revision.title.clone(),
            build: match revision.build {
                BuildState::Building => "building",
                BuildState::Verified { .. } => "verified",
                BuildState::Failed { .. } => "failed",
            },
            failure_reason: match &revision.build {
                BuildState::Failed { reason, .. } => Some(reason.clone()),
                _ => None,
            },
            checks_passed: checks.iter().filter(|c| c.passed).count(),
            checks_total: checks.len(),
            failed_checks: checks.iter().filter(|c| !c.passed).map(|c| format!("{}: {}", c.id, c.detail)).collect(),
            package_sha256: artifacts.map(|a| a.package_sha256.to_string()),
            approval: match revision.approval {
                revisions::Approval::Pending => "pending",
                revisions::Approval::Approved { .. } => "approved",
                revisions::Approval::Void { .. } => "void",
            },
            print_validation: match revision.print_validation {
                revisions::PrintValidation::NotTested => "not_tested",
                revisions::PrintValidation::Passed { .. } => "passed",
                revisions::PrintValidation::Failed { .. } => "failed",
            },
            requested_by: revision.requested_by,
            created_at: revision.created_at.clone(),
        }
    }
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
///     let _ = actions.list_signs(20);
/// }
/// ```
///
/// but cannot approve:
///
/// ```compile_fail,E0599
/// # use std::sync::Arc;
/// # use materialize_3d_lib::actions::RequestActions;
/// fn approve_from_a_model(actions: Arc<dyn RequestActions>) {
///     let _ = actions.approve(todo!(), "revision", String::new());
/// }
/// ```
///
/// It builds as a model:
///
/// ```
/// # use std::sync::Arc;
/// # use materialize_3d_lib::actions::{RequestActions, RequestActor};
/// fn build_as_a_model(actions: Arc<dyn RequestActions>) {
///     let _ = actions.build_sign(serde_json::json!({}), None, RequestActor::Agent, &|_| {}, &|| false);
/// }
/// ```
///
/// but cannot build as a person:
///
/// ```compile_fail,E0308
/// # use std::sync::Arc;
/// # use materialize_3d_lib::actions::RequestActions;
/// # use materialize_3d_lib::fabrication::revisions::Actor;
/// fn build_as_a_person(actions: Arc<dyn RequestActions>) {
///     let _ = actions.build_sign(serde_json::json!({}), None, Actor::Human, &|_| {}, &|| false);
/// }
/// ```
pub trait RequestActions: Send + Sync + 'static {
    /// Blocking; see [`Actions::build_sign`]. The revision records `requester`
    /// as `requested_by`, which can never be a person through this trait.
    fn build_sign(
        &self,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        progress: &dyn Fn(BuildStep),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<BuildOutcome, ActionError>;
    fn list_signs(&self, limit: u32) -> Result<Vec<SignRevision>, ActionError>;
    fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError>;
    fn show_sign(&self, id: &str) -> Result<(), ActionError>;
    fn printer_status(&self) -> Result<PrinterState, ActionError>;
}

#[derive(Clone)]
pub struct Actions {
    emit: EventSink,
    state: Arc<AppState>,
    workspace: Workspace,
}

impl Actions {
    /// `emit` delivers [`SIGNS_CHANGED`] and [`SIGNS_OPEN`]; no Tauri runtime is needed.
    pub fn new(emit: EventSink, state: Arc<AppState>, workspace: Workspace) -> Self {
        Self { emit, state, workspace }
    }

    fn notify(&self, id: &RevisionId) {
        (self.emit)(SIGNS_CHANGED, Value::String(id.to_string()));
    }

    /// Blocking: geometry and slicing run on the calling thread. Async callers
    /// use `spawn_blocking`.
    pub fn build_sign(
        &self,
        spec: Value,
        lineage_id: Option<&str>,
        actor: Actor,
        progress: &dyn Fn(BuildStep),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<BuildOutcome, ActionError> {
        let lineage_id = lineage_id.map(LineageId::parse).transpose()?;
        let outcome = pipeline::build_sign(
            &self.state,
            &self.workspace,
            BuildRequest { spec, lineage_id, actor },
            progress,
            is_cancelled,
        )?;
        self.notify(&outcome.revision.id);
        Ok(outcome)
    }

    pub fn list_signs(&self, limit: u32) -> Result<Vec<SignRevision>, ActionError> {
        Ok(pipeline::with_db(&self.state, |conn| revisions::list_recent(conn, limit))?)
    }

    pub fn sign_lineage(&self, lineage_id: &str) -> Result<Vec<SignRevision>, ActionError> {
        let lineage = LineageId::parse(lineage_id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::list_lineage(conn, &lineage))?)
    }

    /// Re-hashes an approved package first, so a changed file reads as void.
    pub fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::check_integrity(conn, &id))?)
    }

    pub fn sign_preview_png(&self, id: &str) -> Result<Vec<u8>, ActionError> {
        let revision = self.get_sign(id)?;
        let artifacts = revision.artifacts().ok_or_else(|| ActionError::State("this revision has no preview".into()))?;
        std::fs::read(&artifacts.preview_path).map_err(|e| ActionError::State(e.to_string()))
    }

    /// Asks the UI to show a revision. Agents use this to hand a result to a person.
    pub fn show_sign(&self, id: &str) -> Result<(), ActionError> {
        let id = RevisionId::parse(id)?;
        (self.emit)(SIGNS_OPEN, serde_json::json!({ "revisionId": id.as_str() }));
        Ok(())
    }

    /// Approves the package a person saw, identified by its hash. `revisions::approve`
    /// checks the actor again, so the rule holds in both the types and the transition.
    pub fn approve(&self, who: &HumanActor, id: &str, package_sha256: String) -> Result<SignRevision, ActionError> {
        let id = RevisionId::parse(id)?;
        let expected = Sha256Hex::try_from(package_sha256)?;
        let revision = pipeline::with_db(&self.state, |conn| revisions::approve(conn, &id, &expected, who.actor()))?;
        self.notify(&revision.id);
        Ok(revision)
    }

    /// Copies an approved package to `destination` for a person.
    pub fn export(&self, _who: &HumanActor, id: &str, destination: &Path) -> Result<PathBuf, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(pipeline::with_db(&self.state, |conn| revisions::export(conn, &id, destination))?)
    }

    pub fn record_print_result(
        &self,
        who: &HumanActor,
        id: &str,
        passed: bool,
        note: &str,
    ) -> Result<SignRevision, ActionError> {
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
    fn build_sign(
        &self,
        spec: Value,
        lineage_id: Option<&str>,
        requester: RequestActor,
        progress: &dyn Fn(BuildStep),
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<BuildOutcome, ActionError> {
        Actions::build_sign(self, spec, lineage_id, requester.into(), progress, is_cancelled)
    }

    fn list_signs(&self, limit: u32) -> Result<Vec<SignRevision>, ActionError> {
        Actions::list_signs(self, limit)
    }

    fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError> {
        Actions::get_sign(self, id)
    }

    fn show_sign(&self, id: &str) -> Result<(), ActionError> {
        Actions::show_sign(self, id)
    }

    fn printer_status(&self) -> Result<PrinterState, ActionError> {
        Actions::printer_status(self)
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
        actions.show_sign(id).expect("show");

        assert_eq!(*emitted.lock().expect("emitted"), [(SIGNS_OPEN.to_owned(), serde_json::json!({ "revisionId": id }))]);
    }
}
