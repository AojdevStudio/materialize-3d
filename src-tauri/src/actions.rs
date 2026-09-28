//! Application actions shared by every caller: GUI commands, the in-app agent's
//! tools, and external MCP clients. Each caller passes its [`Actor`]; policy
//! (for example, only people approve) lives in the functions below and the
//! modules they call, never in a caller.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::fabrication::build::{self, BuildError, BuildOutcome, BuildRequest, BuildStep, Workspace};
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

#[derive(Clone)]
pub struct Actions {
    app: AppHandle,
    state: Arc<AppState>,
    workspace: Workspace,
}

impl Actions {
    pub fn new(app: AppHandle, state: Arc<AppState>, workspace: Workspace) -> Self {
        Self { app, state, workspace }
    }

    fn notify(&self, id: &RevisionId) {
        // The UI refreshes on this event; a closed window is not an error.
        let _ = self.app.emit(SIGNS_CHANGED, id);
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
        let outcome = build::build_sign(
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
        Ok(build::with_db(&self.state, |conn| revisions::list_recent(conn, limit))?)
    }

    pub fn sign_lineage(&self, lineage_id: &str) -> Result<Vec<SignRevision>, ActionError> {
        let lineage = LineageId::parse(lineage_id)?;
        Ok(build::with_db(&self.state, |conn| revisions::list_lineage(conn, &lineage))?)
    }

    /// Re-hashes an approved package first, so a changed file reads as void.
    pub fn get_sign(&self, id: &str) -> Result<SignRevision, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(build::with_db(&self.state, |conn| revisions::check_integrity(conn, &id))?)
    }

    pub fn sign_preview_png(&self, id: &str) -> Result<Vec<u8>, ActionError> {
        let revision = self.get_sign(id)?;
        let artifacts = revision.artifacts().ok_or_else(|| ActionError::State("this revision has no preview".into()))?;
        std::fs::read(&artifacts.preview_path).map_err(|e| ActionError::State(e.to_string()))
    }

    /// Asks the UI to show a revision. Agents use this to hand a result to a person.
    pub fn show_sign(&self, id: &str) -> Result<(), ActionError> {
        let id = RevisionId::parse(id)?;
        self.app
            .emit(SIGNS_OPEN, serde_json::json!({ "revisionId": id.as_str() }))
            .map_err(|e| ActionError::State(e.to_string()))
    }

    pub fn approve_sign(&self, id: &str, package_sha256: String, actor: Actor) -> Result<SignRevision, ActionError> {
        let id = RevisionId::parse(id)?;
        let expected = Sha256Hex::try_from(package_sha256)?;
        let revision = build::with_db(&self.state, |conn| revisions::approve(conn, &id, &expected, actor))?;
        self.notify(&revision.id);
        Ok(revision)
    }

    pub fn export_sign(&self, id: &str, destination: &std::path::Path) -> Result<std::path::PathBuf, ActionError> {
        let id = RevisionId::parse(id)?;
        Ok(build::with_db(&self.state, |conn| revisions::export(conn, &id, destination))?)
    }

    pub fn record_print_result(&self, id: &str, passed: bool, note: &str, actor: Actor) -> Result<SignRevision, ActionError> {
        let id = RevisionId::parse(id)?;
        let revision = build::with_db(&self.state, |conn| revisions::record_print_result(conn, &id, passed, note, actor))?;
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
