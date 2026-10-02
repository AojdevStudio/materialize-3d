//! Tauri commands for the Signs view: the GUI's caller of [`Actions`]. These
//! are the only callers that act as `Actor::Human`, and the only code that can
//! create a [`HumanActor`].

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Runtime, State};

use super::{Actions, EventSink};
use crate::fabrication::pipeline::{BuildOutcome, BuildStep};
use crate::fabrication::checks::CheckId;
use crate::fabrication::revisions::{Actor, ExportFormat, Revision};

/// Proof that a person at the GUI is acting. Its field is private to this
/// module, so tools, the agent, and MCP cannot create one, and approving,
/// exporting, or recording a print takes one. That field's visibility is the
/// whole compile-time proof, so never widen it: a `pub(crate)` field would not
/// be caught by the doctests below, which compile outside the crate, and only
/// the runtime `Actor::Human` check in `revisions::approve` would remain.
///
/// Code outside this module can name and use one it was given:
///
/// ```
/// use materialize_3d_lib::actions::HumanActor;
/// use materialize_3d_lib::fabrication::revisions::Actor;
/// fn who(person: &HumanActor) -> Actor {
///     person.actor()
/// }
/// ```
///
/// but cannot create one:
///
/// ```compile_fail,E0423
/// use materialize_3d_lib::actions::HumanActor;
/// let _forged = HumanActor(());
/// ```
pub struct HumanActor(());

impl HumanActor {
    /// The identity recorded for what this person does.
    pub fn actor(&self) -> Actor {
        Actor::Human
    }
}

/// The person using the window, behind every command below that needs one.
const PERSON: HumanActor = HumanActor(());

/// Sends [`Actions`] events to the app's windows.
pub(crate) fn app_events<R: Runtime>(app: AppHandle<R>) -> EventSink {
    Arc::new(move |event, payload| {
        if let Err(err) = app.emit(event, payload) {
            log::warn!("actions: could not emit {event}: {err}");
        }
    })
}

/// Cancel flags for builds started from the GUI, keyed by the caller's build id.
#[derive(Default)]
pub struct GuiBuilds(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl GuiBuilds {
    /// Claims `build_id` for one running build. An id already in use is refused,
    /// so a second caller can neither replace the first build's cancel flag nor
    /// remove it when the second call ends.
    fn register(&self, build_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut running = self.0.lock().map_err(error)?;
        match running.entry(build_id.to_owned()) {
            Entry::Occupied(_) => Err(format!("a build with id {build_id} is already running")),
            Entry::Vacant(slot) => Ok(slot.insert(Arc::new(AtomicBool::new(false))).clone()),
        }
    }

    fn unregister(&self, build_id: &str) {
        if let Ok(mut running) = self.0.lock() {
            running.remove(build_id);
        }
    }

    /// Asks the running build to stop. False when no build has this id.
    fn cancel(&self, build_id: &str) -> Result<bool, String> {
        let running = self.0.lock().map_err(error)?;
        Ok(running.get(build_id).map(|flag| flag.store(true, Ordering::Relaxed)).is_some())
    }
}

fn error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[tauri::command]
pub async fn sign_build(
    actions: State<'_, Actions>,
    builds: State<'_, GuiBuilds>,
    spec: Value,
    lineage_id: Option<String>,
    build_id: String,
    on_progress: Channel<BuildStep>,
) -> Result<BuildOutcome, String> {
    let cancel = builds.register(&build_id)?;
    let actions = actions.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        actions.build_sign(
            spec,
            lineage_id.as_deref(),
            Actor::Human,
            &|step| {
                let _ = on_progress.send(step);
            },
            &|| cancel.load(Ordering::Relaxed),
        )
    })
    .await
    .map_err(error);
    builds.unregister(&build_id);
    outcome?.map_err(error)
}

#[tauri::command]
pub fn sign_cancel(builds: State<'_, GuiBuilds>, build_id: String) -> Result<bool, String> {
    builds.cancel(&build_id)
}

#[tauri::command]
pub fn sign_list(actions: State<'_, Actions>, limit: Option<u32>) -> Result<Vec<Revision>, String> {
    actions.list_signs(limit.unwrap_or(100)).map_err(error)
}

#[tauri::command]
pub fn sign_lineage(actions: State<'_, Actions>, lineage_id: String) -> Result<Vec<Revision>, String> {
    actions.sign_lineage(&lineage_id).map_err(error)
}

#[tauri::command]
pub fn sign_get(actions: State<'_, Actions>, id: String) -> Result<Revision, String> {
    actions.get_sign(&id).map_err(error)
}

#[tauri::command]
pub fn sign_preview(actions: State<'_, Actions>, id: String) -> Result<Response, String> {
    actions.sign_preview_png(&id).map(Response::new).map_err(error)
}

#[tauri::command]
pub fn sign_approve(
    actions: State<'_, Actions>,
    id: String,
    package_sha256: String,
    acknowledged_warnings: BTreeSet<CheckId>,
) -> Result<Revision, String> {
    actions.approve(&PERSON, &id, package_sha256, acknowledged_warnings).map_err(error)
}

#[tauri::command]
pub fn sign_export(actions: State<'_, Actions>, id: String, format: ExportFormat, destination: String) -> Result<String, String> {
    actions
        .export(&PERSON, &id, format, &PathBuf::from(destination))
        .map(|written| written.display().to_string())
        .map_err(error)
}

#[tauri::command]
pub fn sign_record_print(
    actions: State<'_, Actions>,
    id: String,
    passed: bool,
    note: String,
) -> Result<Revision, String> {
    actions.record_print_result(&PERSON, &id, passed, &note).map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_duplicate_build_id_is_refused_and_the_first_build_stays_cancellable() {
        let service = GuiBuilds::default();
        let first = service.register("build-1").expect("first registration");
        assert!(service.register("build-1").is_err(), "a second build with the same id is refused");
        assert_eq!(service.cancel("build-1"), Ok(true));
        assert!(first.load(Ordering::Relaxed), "cancel reaches the first build");
        service.unregister("build-1");
        assert!(service.register("build-1").is_ok(), "the id is free once the first build ends");
    }
}
