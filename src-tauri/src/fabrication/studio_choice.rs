//! The Bambu Studio app a person chose in Settings, kept in the `settings`
//! table. The sign pipeline passes it to [`BambuStudio::locate`]; Settings
//! reads and changes it through `studio_commands`.

use std::path::{Path, PathBuf};

use super::bambu::BambuStudio;
use crate::database;
use crate::state::AppState;

const SETTING: &str = "bambu_studio.path";

fn with_conn<T>(
    state: &AppState,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state
        .db
        .lock()
        .map_err(|e| format!("failed to lock db: {e}"))?;
    f(guard
        .as_ref()
        .ok_or_else(|| "database not initialized".to_string())?)
}

/// The stored choice, if the person made one.
pub fn chosen(state: &AppState) -> Result<Option<PathBuf>, String> {
    with_conn(state, |conn| {
        Ok(database::get_setting(conn, SETTING)?.map(PathBuf::from))
    })
}

/// Probes `path` and stores it only when it is a validated Bambu Studio.
pub fn choose(state: &AppState, path: &Path) -> Result<(), String> {
    BambuStudio::at(path).map_err(|e| e.to_string())?;
    let value = path
        .to_str()
        .ok_or_else(|| format!("{} is not a UTF-8 path", path.display()))?;
    with_conn(state, |conn| database::upsert_setting(conn, SETTING, value))
}

/// Forgets the choice, so discovery decides again.
pub fn clear(state: &AppState) -> Result<(), String> {
    with_conn(state, |conn| database::delete_setting(conn, SETTING))
}
