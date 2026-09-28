//! Tauri commands for the Signs view. These are the GUI's callers of the shared
//! fabrication functions; they are the only callers that act as `Actor::Human`.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, State};

use crate::fabrication::build::{self, BuildOutcome, BuildRequest, BuildStep, Workspace};
use crate::fabrication::revisions::{self, Actor, LineageId, RevisionId, Sha256Hex, SignRevision};
use crate::state::AppState;

pub const SIGNS_CHANGED: &str = "signs:changed";

/// Build workspace plus cancel flags for builds started from the GUI.
pub struct SignService {
    pub workspace: Workspace,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SignService {
    pub fn new(workspace: Workspace) -> Self {
        Self { workspace, running: Mutex::new(HashMap::new()) }
    }

    /// Claims `build_id` for one running build. An id already in use is refused,
    /// so a second caller can neither replace the first build's cancel flag nor
    /// remove it when the second call ends.
    fn register(&self, build_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut running = self.running.lock().map_err(error)?;
        match running.entry(build_id.to_owned()) {
            Entry::Occupied(_) => Err(format!("a build with id {build_id} is already running")),
            Entry::Vacant(slot) => Ok(slot.insert(Arc::new(AtomicBool::new(false))).clone()),
        }
    }

    fn unregister(&self, build_id: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(build_id);
        }
    }

    /// Asks the running build to stop. False when no build has this id.
    fn cancel(&self, build_id: &str) -> Result<bool, String> {
        let running = self.running.lock().map_err(error)?;
        Ok(running.get(build_id).map(|flag| flag.store(true, Ordering::Relaxed)).is_some())
    }
}

fn error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

fn revision_id(id: &str) -> Result<RevisionId, String> {
    RevisionId::parse(id).map_err(error)
}

#[tauri::command]
pub async fn sign_build(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    service: State<'_, SignService>,
    spec: Value,
    lineage_id: Option<String>,
    build_id: String,
    on_progress: Channel<BuildStep>,
) -> Result<BuildOutcome, String> {
    let lineage_id = lineage_id.as_deref().map(LineageId::parse).transpose().map_err(error)?;
    let cancel = service.register(&build_id)?;
    let (state, workspace) = (state.inner().clone(), service.workspace.clone());
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        build::build_sign(
            &state,
            &workspace,
            BuildRequest { spec, lineage_id, actor: Actor::Human },
            &|step| {
                let _ = on_progress.send(step);
            },
            &|| cancel.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(error);
    service.unregister(&build_id);
    let outcome = outcome?.map_err(error)?;
    let _ = app.emit(SIGNS_CHANGED, &outcome.revision.id);
    Ok(outcome)
}

#[tauri::command]
pub fn sign_cancel(service: State<'_, SignService>, build_id: String) -> Result<bool, String> {
    service.cancel(&build_id)
}

#[tauri::command]
pub fn sign_list(state: State<'_, Arc<AppState>>, limit: Option<u32>) -> Result<Vec<SignRevision>, String> {
    build::with_db(&state, |conn| revisions::list_recent(conn, limit.unwrap_or(100))).map_err(error)
}

#[tauri::command]
pub fn sign_lineage(state: State<'_, Arc<AppState>>, lineage_id: String) -> Result<Vec<SignRevision>, String> {
    let lineage = LineageId::parse(&lineage_id).map_err(error)?;
    build::with_db(&state, |conn| revisions::list_lineage(conn, &lineage)).map_err(error)
}

/// Returns the revision after re-hashing an approved package, so a file changed
/// on disk shows up as a void approval the moment the revision is opened.
#[tauri::command]
pub fn sign_get(state: State<'_, Arc<AppState>>, id: String) -> Result<SignRevision, String> {
    let id = revision_id(&id)?;
    build::with_db(&state, |conn| revisions::check_integrity(conn, &id)).map_err(error)
}

#[tauri::command]
pub fn sign_preview(state: State<'_, Arc<AppState>>, id: String) -> Result<Response, String> {
    let id = revision_id(&id)?;
    let revision = build::with_db(&state, |conn| revisions::get(conn, &id)).map_err(error)?;
    let artifacts = revision.artifacts().ok_or("this revision has no preview")?;
    std::fs::read(&artifacts.preview_path).map(Response::new).map_err(error)
}

#[tauri::command]
pub fn sign_approve(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
    package_sha256: String,
) -> Result<SignRevision, String> {
    let id = revision_id(&id)?;
    let expected = Sha256Hex::try_from(package_sha256).map_err(error)?;
    let revision = build::with_db(&state, |conn| revisions::approve(conn, &id, &expected, Actor::Human)).map_err(error)?;
    let _ = app.emit(SIGNS_CHANGED, &revision.id);
    Ok(revision)
}

#[tauri::command]
pub fn sign_export(state: State<'_, Arc<AppState>>, id: String, destination: String) -> Result<String, String> {
    let id = revision_id(&id)?;
    let destination = PathBuf::from(destination);
    let written = build::with_db(&state, |conn| revisions::export(conn, &id, &destination)).map_err(error)?;
    Ok(written.display().to_string())
}

#[tauri::command]
pub fn sign_record_print(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
    passed: bool,
    note: String,
) -> Result<SignRevision, String> {
    let id = revision_id(&id)?;
    let revision =
        build::with_db(&state, |conn| revisions::record_print_result(conn, &id, passed, &note, Actor::Human)).map_err(error)?;
    let _ = app.emit(SIGNS_CHANGED, &revision.id);
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_duplicate_build_id_is_refused_and_the_first_build_stays_cancellable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let service = SignService::new(Workspace::new(&dir.path().join("data"), &dir.path().join("cache")));
        let first = service.register("build-1").expect("first registration");
        assert!(service.register("build-1").is_err(), "a second build with the same id is refused");
        assert_eq!(service.cancel("build-1"), Ok(true));
        assert!(first.load(Ordering::Relaxed), "cancel reaches the first build");
        service.unregister("build-1");
        assert!(service.register("build-1").is_ok(), "the id is free once the first build ends");
    }
}
