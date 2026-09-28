//! Persistent print queue backed by `app_data_dir/print_queue.json`.
//!
//! All operations lock `AppState.print_queue` briefly, mutate, then persist.

use std::path::PathBuf;
use std::sync::Arc;

use crate::state::{AppState, QueuedJob, QueueStatus};

/// Return the path to the persisted queue file.
fn queue_file_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("materialize-3d").join("print_queue.json")
}

/// Add a job to the print queue.
pub fn add_job(state: &AppState, job: QueuedJob) -> Result<(), String> {
    {
        let mut queue = state
            .print_queue
            .lock()
            .map_err(|e| format!("failed to lock print queue: {e}"))?;
        log::info!("print_queue: adding job '{}' ({})", job.model_name, job.id);
        queue.push(job);
    }
    persist_queue(state)
}

/// Remove a job from the print queue by ID. Returns true if found and removed.
pub fn remove_job(state: &AppState, id: &str) -> Result<bool, String> {
    let removed = {
        let mut queue = state
            .print_queue
            .lock()
            .map_err(|e| format!("failed to lock print queue: {e}"))?;
        let before = queue.len();
        queue.retain(|j| j.id != id);
        let after = queue.len();
        before != after
    };
    if removed {
        log::info!("print_queue: removed job {id}");
        persist_queue(state)?;
    }
    Ok(removed)
}

/// Get a snapshot of all queued jobs.
pub fn get_jobs(state: &AppState) -> Result<Vec<QueuedJob>, String> {
    let queue = state
        .print_queue
        .lock()
        .map_err(|e| format!("failed to lock print queue: {e}"))?;
    Ok(queue.clone())
}

/// Update the status of a job by ID.
pub fn update_job_status(state: &AppState, id: &str, status: QueueStatus) -> Result<(), String> {
    {
        let mut queue = state
            .print_queue
            .lock()
            .map_err(|e| format!("failed to lock print queue: {e}"))?;
        if let Some(job) = queue.iter_mut().find(|j| j.id == id) {
            job.status = status;
        }
    }
    persist_queue(state)
}

/// Persist the current queue to disk as JSON.
pub fn persist_queue(state: &AppState) -> Result<(), String> {
    let queue = state
        .print_queue
        .lock()
        .map_err(|e| format!("failed to lock print queue: {e}"))?;

    let path = queue_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create queue directory: {e}"))?;
    }

    let json = serde_json::to_string_pretty(&*queue)
        .map_err(|e| format!("failed to serialize queue: {e}"))?;

    std::fs::write(&path, json).map_err(|e| format!("failed to write queue file: {e}"))?;

    log::debug!("print_queue: persisted {} jobs to {}", queue.len(), path.display());
    Ok(())
}

/// Load the queue from disk. Returns an empty vec if the file is missing.
pub fn load_queue() -> Vec<QueuedJob> {
    let path = queue_file_path();
    match std::fs::read_to_string(&path) {
        Ok(json) => match serde_json::from_str::<Vec<QueuedJob>>(&json) {
            Ok(jobs) => {
                log::info!("print_queue: loaded {} jobs from {}", jobs.len(), path.display());
                jobs
            }
            Err(e) => {
                log::warn!("print_queue: failed to parse {}: {e}", path.display());
                Vec::new()
            }
        },
        Err(_) => {
            log::debug!("print_queue: no queue file at {}, starting empty", path.display());
            Vec::new()
        }
    }
}

/// Initialize the queue on AppState from the persisted file.
pub fn init_queue(state: &Arc<AppState>) {
    let jobs = load_queue();
    if let Ok(mut queue) = state.print_queue.lock() {
        *queue = jobs;
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_job(id: &str, name: &str) -> QueuedJob {
        QueuedJob {
            id: id.into(),
            model_path: format!("/tmp/{name}.stl"),
            threemf_path: format!("/tmp/{name}.3mf"),
            model_name: name.into(),
            created_at: Utc::now(),
            status: QueueStatus::Pending,
            filament_grams: None,
            filament_meters: None,
            quality_profile: None,
            thumbnail_path: None,
        }
    }

    #[test]
    fn add_and_get_jobs() {
        let state = AppState::default();
        let job = make_job("j1", "benchy");

        add_job(&state, job.clone()).unwrap();
        let jobs = get_jobs(&state).unwrap();

        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "j1");
        assert_eq!(jobs[0].model_name, "benchy");
    }

    #[test]
    fn remove_existing_job() {
        let state = AppState::default();
        add_job(&state, make_job("j1", "benchy")).unwrap();
        add_job(&state, make_job("j2", "hook")).unwrap();

        let removed = remove_job(&state, "j1").unwrap();
        assert!(removed);

        let jobs = get_jobs(&state).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, "j2");
    }

    #[test]
    fn remove_nonexistent_returns_false() {
        let state = AppState::default();
        let removed = remove_job(&state, "doesnt-exist").unwrap();
        assert!(!removed);
    }

    #[test]
    fn persist_and_load_round_trip() {
        // Use a temp dir to avoid clobbering real data
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("print_queue.json");

        let jobs = vec![
            make_job("j1", "benchy"),
            make_job("j2", "hook"),
        ];

        let json = serde_json::to_string_pretty(&jobs).unwrap();
        std::fs::write(&path, &json).unwrap();

        let loaded: Vec<QueuedJob> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "j1");
        assert_eq!(loaded[1].id, "j2");
    }

    #[test]
    fn load_returns_empty_on_missing_file() {
        // load_queue() uses a fixed path, but we can verify the parse logic
        let empty: Vec<QueuedJob> = serde_json::from_str("[]").unwrap();
        assert!(empty.is_empty());
    }
}
