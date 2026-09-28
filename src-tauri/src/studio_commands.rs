//! Tauri commands for the Bambu Studio section of Settings. Each one runs the
//! app's `--help` to read its version, so they run off the main thread.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::fabrication::bambu::{studio_status, StudioStatus};
use crate::fabrication::studio_choice;
use crate::state::AppState;

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn status_now(state: &AppState) -> Result<StudioStatus, String> {
    Ok(studio_status(studio_choice::chosen(state)?.as_deref()))
}

/// What the app would slice with: found, found but unvalidated, or not found.
#[tauri::command]
pub async fn bambu_studio_status(state: State<'_, Arc<AppState>>) -> Result<StudioStatus, String> {
    let state = state.inner().clone();
    blocking(move || status_now(&state)).await
}

/// Stores `path` when it is a validated Bambu Studio; otherwise returns why and
/// leaves the previous choice in place.
#[tauri::command]
pub async fn choose_bambu_studio(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<StudioStatus, String> {
    let state = state.inner().clone();
    blocking(move || {
        studio_choice::choose(&state, &PathBuf::from(path))?;
        status_now(&state)
    })
    .await
}

/// Forgets the chosen app so the standard install locations are searched again.
#[tauri::command]
pub async fn clear_bambu_studio(state: State<'_, Arc<AppState>>) -> Result<StudioStatus, String> {
    let state = state.inner().clone();
    blocking(move || {
        studio_choice::clear(&state)?;
        status_now(&state)
    })
    .await
}
