//! SQLite database layer for print history and model library.
//!
//! Uses `rusqlite` with bundled SQLite. WAL mode enabled for concurrent reads.
//! Migrations tracked via `PRAGMA user_version`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};

use crate::state::{LibraryModel, PrintHistoryRecord, PrinterConfig};

// ─── Compat Types for Filesystem Scan ─────────────────────────────────────────

/// Model info nested inside `StoredImportMetadataCompat`.
/// Mirrors the `MakerWorldModel` shape written by `makerworld.rs` without coupling.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredModelCompat {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    rating: Option<f32>,
    #[serde(default)]
    download_count: Option<u32>,
    #[serde(default)]
    source_url: Option<String>,
}

/// Parallel deserialization struct for `metadata.json` files produced by the
/// MakerWorld importer. Avoids coupling to `makerworld.rs` private types.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredImportMetadataCompat {
    #[serde(default)]
    imported_at: Option<String>,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    model: Option<StoredModelCompat>,
    #[serde(default)]
    files: Vec<String>,
}

/// Open (or create) the SQLite database, enable WAL + foreign keys, and run migrations.
pub fn init_db(db_path: &Path) -> Result<Connection, String> {
    log::info!("database: initializing SQLite at {}", db_path.display());

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create database directory: {e}"))?;
    }

    let conn = Connection::open(db_path)
        .map_err(|e| format!("failed to open SQLite database: {e}"))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("failed to set WAL journal mode: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("failed to enable foreign keys: {e}"))?;

    run_migrations(&conn)?;

    log::info!("database: ready (WAL mode, foreign keys ON)");
    Ok(conn)
}

/// Schema version after every migration has run.
pub const SCHEMA_VERSION: i32 = 6;

/// Run all pending migrations based on `PRAGMA user_version`.
fn run_migrations(conn: &Connection) -> Result<(), String> {
    let version: i32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("failed to read user_version: {e}"))?;

    log::info!("database: current schema version = {version}");

    if version < 1 {
        log::info!("database: applying migration 001 — create print_history table");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS print_history (
                id TEXT PRIMARY KEY,
                model_name TEXT NOT NULL,
                gcode_file TEXT,
                started_at TEXT,
                completed_at TEXT NOT NULL,
                duration_seconds INTEGER,
                status TEXT NOT NULL,
                fail_reason TEXT,
                filament_grams REAL,
                filament_meters REAL,
                thumbnail_path TEXT,
                quality_profile TEXT
            );",
        )
        .map_err(|e| format!("migration 001 failed: {e}"))?;

        conn.pragma_update(None, "user_version", 1)
            .map_err(|e| format!("failed to set user_version to 1: {e}"))?;
        log::info!("database: migration 001 applied — schema version now 1");
    }

    if version < 2 {
        log::info!("database: applying migration 002 — create library_models table");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS library_models (
                id TEXT PRIMARY KEY,
                model_name TEXT NOT NULL,
                author TEXT,
                source_url TEXT,
                imported_at TEXT NOT NULL,
                thumbnail_url TEXT,
                file_path TEXT,
                folder_path TEXT NOT NULL UNIQUE,
                rating REAL,
                download_count INTEGER,
                file_count INTEGER
            );",
        )
        .map_err(|e| format!("migration 002 failed: {e}"))?;

        conn.pragma_update(None, "user_version", 2)
            .map_err(|e| format!("failed to set user_version to 2: {e}"))?;
        log::info!("database: migration 002 applied — schema version now 2");
    }

    if version < 3 {
        log::info!("database: applying migration 003 — create printer_configs and settings tables");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS printer_configs (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                serial TEXT NOT NULL,
                access_code_keychain_id TEXT NOT NULL,
                is_default INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .map_err(|e| format!("migration 003 failed: {e}"))?;

        conn.pragma_update(None, "user_version", 3)
            .map_err(|e| format!("failed to set user_version to 3: {e}"))?;
        log::info!("database: migration 003 applied — schema version now 3");
    }

    if version < 4 {
        log::info!("database: applying migration 004 — create sign_revisions table");
        conn.execute_batch(crate::fabrication::revisions::MIGRATION_004)
            .map_err(|e| format!("migration 004 failed: {e}"))?;
        conn.pragma_update(None, "user_version", 4)
            .map_err(|e| format!("failed to set user_version to 4: {e}"))?;
        log::info!("database: migration 004 applied — schema version now 4");
    }

    if version < 5 {
        log::info!("database: applying migration 005 — create agent conversation tables");
        conn.execute_batch(crate::agent::store::MIGRATION_005)
            .map_err(|e| format!("migration 005 failed: {e}"))?;
        conn.pragma_update(None, "user_version", 5)
            .map_err(|e| format!("failed to set user_version to 5: {e}"))?;
        log::info!("database: migration 005 applied — schema version now 5");
    }

    if version < 6 {
        // A database that held sign revisions before this run keeps a copy of
        // them: migration 006 is the first one that drops a table.
        if version >= 4 {
            backup_before_schema_6(conn)?;
        }
        log::info!("database: applying migration 006 — separate builds from revisions");
        // It moves rows between tables, so all of it lands or none of it does.
        let tx = conn.unchecked_transaction().map_err(|e| format!("migration 006 failed to start: {e}"))?;
        tx.execute_batch(crate::fabrication::revisions::MIGRATION_006)
            .map_err(|e| format!("migration 006 failed: {e}"))?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|e| format!("failed to set user_version to 6: {e}"))?;
        tx.commit().map_err(|e| format!("migration 006 failed to commit: {e}"))?;
        log::info!("database: migration 006 applied — schema version now 6");
    }

    Ok(())
}

/// Copies the database to `<database>.pre-schema-6` beside it before migration
/// 006 drops `sign_revisions`.
///
/// The copy is written to `<backup>.partial` with `VACUUM INTO` (one consistent
/// file that includes anything still in the WAL), checked against the live
/// database, and only then published under its final name, which is never
/// replaced. A backup that already exists is checked the same way before it is
/// trusted. Anything that goes wrong stops the migration, so the database never
/// reaches schema 6 without a good copy of its sign revisions. An in-memory
/// database has no file to protect.
fn backup_before_schema_6(conn: &Connection) -> Result<(), String> {
    let Some(path) = conn.path().filter(|path| !path.is_empty()) else {
        return Ok(());
    };
    let backup = PathBuf::from(format!("{path}.pre-schema-6"));
    let staged = PathBuf::from(format!("{path}.pre-schema-6.partial"));
    let failed = |why: String| format!("could not back up the database to {} before migration 006: {why}", backup.display());

    let expected = backup_shape(conn).map_err(|e| failed(e.to_string()))?;
    remove_if_present(&staged).map_err(|e| failed(format!("could not remove the stale {}: {e}", staged.display())))?;
    if backup.symlink_metadata().is_ok() {
        verify_backup(&backup, expected).map_err(|why| {
            format!(
                "the existing backup {} is not a copy of this database ({why}); move it aside and launch again",
                backup.display()
            )
        })?;
        log::info!("database: keeping the existing backup {}", backup.display());
        return Ok(());
    }

    conn.execute("VACUUM INTO ?1", [staged.to_string_lossy()]).map_err(|e| failed(e.to_string()))?;
    #[cfg(test)]
    tests::interrupt_backup_if_asked(&staged);
    verify_backup(&staged, expected).map_err(failed)?;
    // A hard link refuses an existing name, so publishing never replaces a backup.
    std::fs::hard_link(&staged, &backup).map_err(|e| failed(format!("could not publish the checked copy: {e}")))?;
    std::fs::remove_file(&staged).map_err(|e| failed(format!("could not remove {} after publishing it: {e}", staged.display())))?;
    log::info!("database: backed up the database to {} before migration 006", backup.display());
    Ok(())
}

/// What a backup must match: the schema version and the number of sign revisions.
fn backup_shape(conn: &Connection) -> rusqlite::Result<(i32, i64)> {
    let version = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let sign_revisions = conn.query_row("SELECT count(*) FROM sign_revisions", [], |row| row.get(0))?;
    Ok((version, sign_revisions))
}

/// Opens the copy at `path` read-only and checks it holds what the live database holds.
fn verify_backup(path: &Path, (version, sign_revisions): (i32, i64)) -> Result<(), String> {
    let copy = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| format!("could not open the copy: {e}"))?;
    let found = backup_shape(&copy).map_err(|e| format!("could not read the copy: {e}"))?;
    if found != (version, sign_revisions) {
        return Err(format!(
            "the copy holds schema {} with {} sign revisions, not schema {version} with {sign_revisions}",
            found.0, found.1
        ));
    }
    Ok(())
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Insert a print history record.
pub fn insert_history(conn: &Connection, record: &PrintHistoryRecord) -> Result<(), String> {
    log::info!(
        "database: inserting history record id={} model='{}' status={}",
        record.id,
        record.model_name,
        record.status
    );

    conn.execute(
        "INSERT INTO print_history (
            id, model_name, gcode_file, started_at, completed_at,
            duration_seconds, status, fail_reason, filament_grams,
            filament_meters, thumbnail_path, quality_profile
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            record.id,
            record.model_name,
            record.gcode_file,
            record.started_at,
            record.completed_at,
            record.duration_seconds,
            record.status,
            record.fail_reason,
            record.filament_grams,
            record.filament_meters,
            record.thumbnail_path,
            record.quality_profile,
        ],
    )
    .map_err(|e| {
        log::error!("database: insert_history failed: {e}");
        format!("failed to insert history record: {e}")
    })?;

    Ok(())
}

/// Get all print history records, ordered by `completed_at` descending (newest first).
pub fn get_all_history(conn: &Connection) -> Result<Vec<PrintHistoryRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, model_name, gcode_file, started_at, completed_at,
                    duration_seconds, status, fail_reason, filament_grams,
                    filament_meters, thumbnail_path, quality_profile
             FROM print_history
             ORDER BY completed_at DESC",
        )
        .map_err(|e| format!("failed to prepare get_all_history query: {e}"))?;

    let records = stmt
        .query_map([], |row| {
            Ok(PrintHistoryRecord {
                id: row.get(0)?,
                model_name: row.get(1)?,
                gcode_file: row.get(2)?,
                started_at: row.get(3)?,
                completed_at: row.get(4)?,
                duration_seconds: row.get(5)?,
                status: row.get(6)?,
                fail_reason: row.get(7)?,
                filament_grams: row.get(8)?,
                filament_meters: row.get(9)?,
                thumbnail_path: row.get(10)?,
                quality_profile: row.get(11)?,
            })
        })
        .map_err(|e| format!("failed to execute get_all_history query: {e}"))?;

    let mut result = Vec::new();
    for record in records {
        result.push(record.map_err(|e| format!("failed to read history row: {e}"))?);
    }

    Ok(result)
}

/// Get a single print history record by ID.
pub fn get_history_item(conn: &Connection, id: &str) -> Result<Option<PrintHistoryRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, model_name, gcode_file, started_at, completed_at,
                    duration_seconds, status, fail_reason, filament_grams,
                    filament_meters, thumbnail_path, quality_profile
             FROM print_history
             WHERE id = ?1",
        )
        .map_err(|e| format!("failed to prepare get_history_item query: {e}"))?;

    let mut rows = stmt
        .query_map(params![id], |row| {
            Ok(PrintHistoryRecord {
                id: row.get(0)?,
                model_name: row.get(1)?,
                gcode_file: row.get(2)?,
                started_at: row.get(3)?,
                completed_at: row.get(4)?,
                duration_seconds: row.get(5)?,
                status: row.get(6)?,
                fail_reason: row.get(7)?,
                filament_grams: row.get(8)?,
                filament_meters: row.get(9)?,
                thumbnail_path: row.get(10)?,
                quality_profile: row.get(11)?,
            })
        })
        .map_err(|e| format!("failed to execute get_history_item query: {e}"))?;

    match rows.next() {
        Some(Ok(record)) => Ok(Some(record)),
        Some(Err(e)) => Err(format!("failed to read history item: {e}")),
        None => Ok(None),
    }
}

/// Delete a print history record by ID. Returns true if a row was deleted.
pub fn delete_history(conn: &Connection, id: &str) -> Result<bool, String> {
    let rows_affected = conn
        .execute("DELETE FROM print_history WHERE id = ?1", params![id])
        .map_err(|e| {
            log::error!("database: delete_history failed for id={id}: {e}");
            format!("failed to delete history record: {e}")
        })?;

    if rows_affected > 0 {
        log::info!("database: deleted history record id={id}");
    }

    Ok(rows_affected > 0)
}

// ─── Library Model CRUD ───────────────────────────────────────────────────────

/// Insert a library model record.
pub fn insert_library_model(conn: &Connection, model: &LibraryModel) -> Result<(), String> {
    log::info!(
        "database: inserting library model id={} name='{}' folder='{}'",
        model.id,
        model.model_name,
        model.folder_path
    );

    conn.execute(
        "INSERT OR IGNORE INTO library_models (
            id, model_name, author, source_url, imported_at,
            thumbnail_url, file_path, folder_path, rating,
            download_count, file_count
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            model.id,
            model.model_name,
            model.author,
            model.source_url,
            model.imported_at,
            model.thumbnail_url,
            model.file_path,
            model.folder_path,
            model.rating,
            model.download_count,
            model.file_count,
        ],
    )
    .map_err(|e| {
        log::error!("database: insert_library_model failed: {e}");
        format!("failed to insert library model: {e}")
    })?;

    Ok(())
}

/// Get all library models, ordered by `imported_at` descending (newest first).
pub fn get_all_library_models(conn: &Connection) -> Result<Vec<LibraryModel>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, model_name, author, source_url, imported_at,
                    thumbnail_url, file_path, folder_path, rating,
                    download_count, file_count
             FROM library_models
             ORDER BY imported_at DESC",
        )
        .map_err(|e| format!("failed to prepare get_all_library_models query: {e}"))?;

    let records = stmt
        .query_map([], |row| {
            Ok(LibraryModel {
                id: row.get(0)?,
                model_name: row.get(1)?,
                author: row.get(2)?,
                source_url: row.get(3)?,
                imported_at: row.get(4)?,
                thumbnail_url: row.get(5)?,
                file_path: row.get(6)?,
                folder_path: row.get(7)?,
                rating: row.get(8)?,
                download_count: row.get(9)?,
                file_count: row.get(10)?,
            })
        })
        .map_err(|e| format!("failed to execute get_all_library_models query: {e}"))?;

    let mut result = Vec::new();
    for record in records {
        result.push(record.map_err(|e| format!("failed to read library model row: {e}"))?);
    }

    Ok(result)
}

/// Search library models by name (case-insensitive LIKE '%query%').
pub fn search_library_models(conn: &Connection, query: &str) -> Result<Vec<LibraryModel>, String> {
    let pattern = format!("%{query}%");
    let mut stmt = conn
        .prepare(
            "SELECT id, model_name, author, source_url, imported_at,
                    thumbnail_url, file_path, folder_path, rating,
                    download_count, file_count
             FROM library_models
             WHERE model_name LIKE ?1
             ORDER BY imported_at DESC",
        )
        .map_err(|e| format!("failed to prepare search_library_models query: {e}"))?;

    let records = stmt
        .query_map(params![pattern], |row| {
            Ok(LibraryModel {
                id: row.get(0)?,
                model_name: row.get(1)?,
                author: row.get(2)?,
                source_url: row.get(3)?,
                imported_at: row.get(4)?,
                thumbnail_url: row.get(5)?,
                file_path: row.get(6)?,
                folder_path: row.get(7)?,
                rating: row.get(8)?,
                download_count: row.get(9)?,
                file_count: row.get(10)?,
            })
        })
        .map_err(|e| format!("failed to execute search_library_models query: {e}"))?;

    let mut result = Vec::new();
    for record in records {
        result.push(record.map_err(|e| format!("failed to read library search row: {e}"))?);
    }

    Ok(result)
}

/// Delete a library model by ID. Removes the DB row and attempts to delete
/// the filesystem folder. If fs deletion fails, the DB row is still removed
/// (the error is logged but not propagated).
pub fn delete_library_model(conn: &Connection, id: &str) -> Result<bool, String> {
    // Look up folder_path before deleting
    let folder_path: Option<String> = conn
        .query_row(
            "SELECT folder_path FROM library_models WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .ok();

    let rows_affected = conn
        .execute("DELETE FROM library_models WHERE id = ?1", params![id])
        .map_err(|e| {
            log::error!("database: delete_library_model failed for id={id}: {e}");
            format!("failed to delete library model: {e}")
        })?;

    if rows_affected > 0 {
        log::info!("database: deleted library model id={id}");

        // Attempt filesystem cleanup
        if let Some(folder) = folder_path {
            if let Err(e) = std::fs::remove_dir_all(&folder) {
                log::error!(
                    "database: failed to remove library folder '{}': {e} (DB row already deleted)",
                    folder
                );
            } else {
                log::info!("database: removed library folder '{folder}'");
            }
        }
    }

    Ok(rows_affected > 0)
}

// ─── Filesystem Scanner ───────────────────────────────────────────────────────

/// Scan a library root directory for `metadata.json` files in subdirectories.
///
/// Reads each `<library_root>/*/metadata.json`, deserializes it, and inserts
/// a `LibraryModel` into the database. Skips entries that already exist
/// (idempotent via `folder_path` UNIQUE constraint with INSERT OR IGNORE).
///
/// Returns the number of newly indexed models.
pub fn scan_library_filesystem(conn: &Connection, library_root: &Path) -> Result<usize, String> {
    if !library_root.exists() {
        log::info!(
            "library: scan directory does not exist: {} — returning 0 models",
            library_root.display()
        );
        return Ok(0);
    }

    let entries = std::fs::read_dir(library_root).map_err(|e| {
        format!(
            "failed to read library directory '{}': {e}",
            library_root.display()
        )
    })?;

    let mut indexed = 0usize;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("library: failed to read directory entry: {e}");
                continue;
            }
        };

        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let metadata_path = path.join("metadata.json");
        if !metadata_path.exists() {
            continue;
        }

        let raw = match std::fs::read_to_string(&metadata_path) {
            Ok(s) => s,
            Err(e) => {
                log::warn!(
                    "library: failed to read '{}': {e}",
                    metadata_path.display()
                );
                continue;
            }
        };

        let meta: StoredImportMetadataCompat = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(e) => {
                log::warn!(
                    "library: failed to parse '{}': {e}",
                    metadata_path.display()
                );
                continue;
            }
        };

        let folder_path_str = path.to_string_lossy().to_string();

        // Derive fields from the nested model if present
        let model_name = meta
            .model
            .as_ref()
            .and_then(|m| m.title.clone())
            .unwrap_or_else(|| {
                path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown".to_string())
            });

        let author = meta.model.as_ref().and_then(|m| m.author.clone());
        let source_url = meta
            .source_url
            .or_else(|| meta.model.as_ref().and_then(|m| m.source_url.clone()));
        let thumbnail_url = meta
            .model
            .as_ref()
            .and_then(|m| m.images.first().cloned());
        let rating = meta.model.as_ref().and_then(|m| m.rating);
        let download_count = meta.model.as_ref().and_then(|m| m.download_count);
        let file_count = Some(meta.files.len() as u32);

        // Pick first file as representative file_path
        let file_path = meta.files.first().map(|f| {
            path.join(f).to_string_lossy().to_string()
        });

        let imported_at = meta
            .imported_at
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        let library_model = LibraryModel {
            id: uuid::Uuid::new_v4().to_string(),
            model_name,
            author,
            source_url,
            imported_at,
            thumbnail_url,
            file_path,
            folder_path: folder_path_str,
            rating,
            download_count,
            file_count,
        };

        if let Err(e) = insert_library_model(conn, &library_model) {
            log::warn!(
                "library: failed to insert model from '{}': {e}",
                path.display()
            );
            continue;
        }

        indexed += 1;
    }

    log::info!("library: indexed {indexed} models from filesystem");
    Ok(indexed)
}

// ─── Printer Config CRUD ──────────────────────────────────────────────────────

/// Insert a new printer config.
pub fn insert_printer_config(conn: &Connection, config: &PrinterConfig) -> Result<(), String> {
    log::info!(
        "database: inserting printer config id={} name='{}'",
        config.id,
        config.name
    );

    conn.execute(
        "INSERT INTO printer_configs (
            id, name, host, serial, access_code_keychain_id,
            is_default, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            config.id,
            config.name,
            config.host,
            config.serial,
            config.access_code_keychain_id,
            config.is_default as i32,
            config.created_at,
            config.updated_at,
        ],
    )
    .map_err(|e| {
        log::error!("database: insert_printer_config failed for id={}: {e}", config.id);
        format!("failed to insert printer config id={}: {e}", config.id)
    })?;

    Ok(())
}

/// Update an existing printer config.
pub fn update_printer_config(conn: &Connection, config: &PrinterConfig) -> Result<(), String> {
    log::info!(
        "database: updating printer config id={} name='{}'",
        config.id,
        config.name
    );

    let rows = conn
        .execute(
            "UPDATE printer_configs SET
                name = ?1, host = ?2, serial = ?3,
                access_code_keychain_id = ?4, is_default = ?5, updated_at = ?6
            WHERE id = ?7",
            params![
                config.name,
                config.host,
                config.serial,
                config.access_code_keychain_id,
                config.is_default as i32,
                config.updated_at,
                config.id,
            ],
        )
        .map_err(|e| {
            log::error!("database: update_printer_config failed for id={}: {e}", config.id);
            format!("failed to update printer config id={}: {e}", config.id)
        })?;

    if rows == 0 {
        return Err(format!("printer config not found: id={}", config.id));
    }

    Ok(())
}

/// Delete a printer config by ID.
pub fn delete_printer_config(conn: &Connection, id: &str) -> Result<(), String> {
    let rows = conn
        .execute("DELETE FROM printer_configs WHERE id = ?1", params![id])
        .map_err(|e| {
            log::error!("database: delete_printer_config failed for id={id}: {e}");
            format!("failed to delete printer config id={id}: {e}")
        })?;

    if rows == 0 {
        return Err(format!("printer config not found: id={id}"));
    }

    log::info!("database: deleted printer config id={id}");
    Ok(())
}

/// Get all printer configs, ordered by name.
pub fn get_all_printer_configs(conn: &Connection) -> Result<Vec<PrinterConfig>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, host, serial, access_code_keychain_id,
                    is_default, created_at, updated_at
             FROM printer_configs
             ORDER BY name ASC",
        )
        .map_err(|e| format!("failed to prepare get_all_printer_configs query: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            let is_default_int: i32 = row.get(5)?;
            Ok(PrinterConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                serial: row.get(3)?,
                access_code_keychain_id: row.get(4)?,
                is_default: is_default_int != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| format!("failed to execute get_all_printer_configs query: {e}"))?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| format!("failed to read printer config row: {e}"))?);
    }
    Ok(result)
}

/// Get a single printer config by ID.
pub fn get_printer_config(conn: &Connection, id: &str) -> Result<Option<PrinterConfig>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, host, serial, access_code_keychain_id,
                    is_default, created_at, updated_at
             FROM printer_configs
             WHERE id = ?1",
        )
        .map_err(|e| format!("failed to prepare get_printer_config query: {e}"))?;

    let mut rows = stmt
        .query_map(params![id], |row| {
            let is_default_int: i32 = row.get(5)?;
            Ok(PrinterConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                serial: row.get(3)?,
                access_code_keychain_id: row.get(4)?,
                is_default: is_default_int != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| format!("failed to execute get_printer_config query: {e}"))?;

    match rows.next() {
        Some(Ok(config)) => Ok(Some(config)),
        Some(Err(e)) => Err(format!("failed to read printer config: {e}")),
        None => Ok(None),
    }
}

/// Set a printer config as default — clears `is_default` on all, sets on target.
pub fn set_default_printer_config(conn: &Connection, id: &str) -> Result<(), String> {
    // Verify target exists first
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM printer_configs WHERE id = ?1",
            params![id],
            |row| row.get::<_, i32>(0),
        )
        .map(|c| c > 0)
        .map_err(|e| format!("failed to check printer config exists id={id}: {e}"))?;

    if !exists {
        return Err(format!("printer config not found: id={id}"));
    }

    conn.execute("UPDATE printer_configs SET is_default = 0", [])
        .map_err(|e| format!("failed to clear default printer configs: {e}"))?;

    conn.execute(
        "UPDATE printer_configs SET is_default = 1 WHERE id = ?1",
        params![id],
    )
    .map_err(|e| format!("failed to set default printer config id={id}: {e}"))?;

    log::info!("database: set default printer config id={id}");
    Ok(())
}

// ─── Settings CRUD ────────────────────────────────────────────────────────────

/// Default settings. Callers always get a complete map — stored values overlay these.
const SETTING_DEFAULTS: &[(&str, &str)] = &[
    ("default.quality", "0.20"),
    ("default.filament", "PLA Basic"),
    ("notifications.print_complete", "true"),
    ("notifications.print_failed", "true"),
    ("notifications.filament_low", "true"),
    ("connection.auto_connect", "false"),
];

/// Get a single setting by key. Returns `None` if not stored.
pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| format!("failed to prepare get_setting query: {e}"))?;

    let mut rows = stmt
        .query_map(params![key], |row| row.get::<_, String>(0))
        .map_err(|e| format!("failed to execute get_setting query: {e}"))?;

    match rows.next() {
        Some(Ok(value)) => Ok(Some(value)),
        Some(Err(e)) => Err(format!("failed to read setting: {e}")),
        None => Ok(None),
    }
}

/// Get all settings, merging defaults under stored values.
/// Callers always get a complete map with all known keys.
pub fn get_all_settings(conn: &Connection) -> Result<HashMap<String, String>, String> {
    // Start with defaults
    let mut map: HashMap<String, String> = SETTING_DEFAULTS
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    // Overlay stored values
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| format!("failed to prepare get_all_settings query: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("failed to execute get_all_settings query: {e}"))?;

    for row in rows {
        let (key, value) = row.map_err(|e| format!("failed to read settings row: {e}"))?;
        map.insert(key, value);
    }

    Ok(map)
}

/// Insert or replace a setting. Sets `updated_at` to current UTC time.
pub fn upsert_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        params![key, value, now],
    )
    .map_err(|e| {
        log::error!("database: upsert_setting failed for key={key}: {e}");
        format!("failed to upsert setting key={key}: {e}")
    })?;

    log::info!("settings:upserted key={key}");
    Ok(())
}

/// Remove a stored setting. Removing a missing key is not an error.
pub fn delete_setting(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])
        .map_err(|e| format!("failed to delete setting key={key}: {e}"))?;
    log::info!("settings:deleted key={key}");
    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{LibraryModel, PrintHistoryRecord};

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        run_migrations(&conn).unwrap();
        conn
    }

    fn make_record(id: &str, model_name: &str, completed_at: &str, status: &str) -> PrintHistoryRecord {
        PrintHistoryRecord {
            id: id.into(),
            model_name: model_name.into(),
            gcode_file: Some("plate_1.gcode".into()),
            started_at: Some("2026-03-15T10:00:00Z".into()),
            completed_at: completed_at.into(),
            duration_seconds: Some(3600),
            status: status.into(),
            fail_reason: None,
            filament_grams: Some(12.5),
            filament_meters: Some(4.2),
            thumbnail_path: None,
            quality_profile: Some("0.20mm Standard".into()),
        }
    }

    #[test]
    fn insert_and_get_round_trip() {
        let conn = test_db();
        let record = make_record("r1", "Benchy", "2026-03-15T11:00:00Z", "completed");

        insert_history(&conn, &record).unwrap();

        let item = get_history_item(&conn, "r1").unwrap();
        assert!(item.is_some());
        let item = item.unwrap();
        assert_eq!(item.id, "r1");
        assert_eq!(item.model_name, "Benchy");
        assert_eq!(item.status, "completed");
        assert_eq!(item.gcode_file.as_deref(), Some("plate_1.gcode"));
        assert_eq!(item.started_at.as_deref(), Some("2026-03-15T10:00:00Z"));
        assert_eq!(item.completed_at, "2026-03-15T11:00:00Z");
        assert_eq!(item.duration_seconds, Some(3600));
        assert_eq!(item.filament_grams, Some(12.5));
        assert_eq!(item.filament_meters, Some(4.2));
        assert_eq!(item.quality_profile.as_deref(), Some("0.20mm Standard"));
    }

    #[test]
    fn delete_removes_record() {
        let conn = test_db();
        let record = make_record("r1", "Benchy", "2026-03-15T11:00:00Z", "completed");
        insert_history(&conn, &record).unwrap();

        let deleted = delete_history(&conn, "r1").unwrap();
        assert!(deleted);

        let item = get_history_item(&conn, "r1").unwrap();
        assert!(item.is_none());

        // Deleting again returns false
        let deleted_again = delete_history(&conn, "r1").unwrap();
        assert!(!deleted_again);
    }

    #[test]
    fn get_all_returns_descending_order() {
        let conn = test_db();

        // Insert in chronological order
        insert_history(&conn, &make_record("r1", "First", "2026-03-15T09:00:00Z", "completed")).unwrap();
        insert_history(&conn, &make_record("r2", "Second", "2026-03-15T10:00:00Z", "completed")).unwrap();
        insert_history(&conn, &make_record("r3", "Third", "2026-03-15T11:00:00Z", "failed")).unwrap();

        let all = get_all_history(&conn).unwrap();
        assert_eq!(all.len(), 3);
        // Newest first
        assert_eq!(all[0].model_name, "Third");
        assert_eq!(all[1].model_name, "Second");
        assert_eq!(all[2].model_name, "First");
    }

    #[test]
    fn a_database_from_the_released_schema_keeps_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("materialize.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch(include_str!("../tests/fixtures/db/main-schema-v3.sql"))
            .unwrap();

        let conn = init_db(&path).expect("migrates a schema-3 database");
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let history = get_all_history(&conn).unwrap();
        assert_eq!(history.len(), 2);
        assert!(history.iter().any(|h| h.id == "h1" && h.model_name == "Cable Clip" && h.filament_grams == Some(12.5)));
        assert!(history.iter().any(|h| h.id == "h2" && h.fail_reason.as_deref() == Some("filament runout")));
        let library = get_all_library_models(&conn).unwrap();
        assert_eq!(library.len(), 1);
        assert_eq!(library[0].folder_path, "/lib/hook");
        let printer = get_printer_config(&conn, "p1").unwrap().expect("printer config kept");
        assert_eq!((printer.name.as_str(), printer.host.as_str(), printer.is_default), ("Shop P2S", "192.0.2.10", true));
        assert_eq!(get_setting(&conn, "onboarding.completed").unwrap().as_deref(), Some("true"));
        assert_eq!(get_setting(&conn, "default.quality").unwrap().as_deref(), Some("0.16"));

        drop(conn);
        let reopened = init_db(&path).expect("reopening is a no-op");
        assert_eq!(get_all_history(&reopened).unwrap().len(), 2);
    }

    /// A revision's columns that a migration must carry over unchanged.
    type RevisionColumns = (String, String, u32, Option<String>, String, String, String, String, String, Option<String>, String, Option<String>);

    fn revision_columns(conn: &Connection, sql: &str) -> Vec<RevisionColumns> {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?,
            ))
        });
        rows.unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    /// Build state a migration must carry over unchanged, per revision id.
    fn build_columns(conn: &Connection, sql: &str) -> Vec<(String, String, String, Option<String>, Option<String>)> {
        let mut stmt = conn.prepare(sql).unwrap();
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)));
        rows.unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    #[test]
    fn a_schema_5_database_with_signs_moves_to_builds_and_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("materialize.db");
        let before = Connection::open(&path).unwrap();
        before.execute_batch(include_str!("../tests/fixtures/db/main-schema-v5-signs.sql")).unwrap();
        let revisions_before = revision_columns(
            &before,
            "SELECT id, lineage_id, number, parent_id, title, spec_json, spec_sha256, requested_by, approval_status,
                 approved_sha256, print_status, void_reason FROM sign_revisions ORDER BY id",
        );
        let builds_before = build_columns(
            &before,
            "SELECT id, build_key, build_status, failure_reason, artifacts_json FROM sign_revisions ORDER BY id",
        );
        drop(before);
        assert_eq!(revisions_before.len(), 5);

        let conn = init_db(&path).expect("migrates a schema-5 database");
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, 6);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('builds', 'revisions', 'revision_exports', 'sign_revisions') ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(tables, ["builds", "revision_exports", "revisions"]);

        let revisions_after = revision_columns(
            &conn,
            "SELECT id, lineage_id, number, parent_id, title, spec_json, spec_sha256, requested_by, approval_status,
                 approved_package_sha256, print_status, void_reason FROM revisions ORDER BY id",
        );
        assert_eq!(revisions_after, revisions_before, "ids, ancestry, specs, and human decisions are unchanged");
        let builds_after = build_columns(
            &conn,
            "SELECT r.id, b.build_key, b.build_status, b.failure_reason, b.artifacts_json
             FROM revisions r JOIN builds b ON b.id = r.build_id ORDER BY r.id",
        );
        assert_eq!(builds_after, builds_before, "each revision keeps its build key, build status, and artifacts as stored");
        let odd: i64 = conn
            .query_row("SELECT count(*) FROM revisions r JOIN builds b ON b.id = r.build_id WHERE r.kind != 'sign' OR b.legacy != 1 OR r.build_id != r.id", [], |row| row.get(0))
            .unwrap();
        assert_eq!(odd, 0, "every migrated revision is a sign on its own legacy build");

        let listed = crate::fabrication::revisions::list_recent(&conn, 10).expect("every migrated row reads back");
        assert_eq!(listed.len(), 5);
        assert_eq!(crate::fabrication::revisions::unfinished_builds(&conn).unwrap().len(), 1, "the interrupted build is still found");
        assert_eq!(get_all_history(&conn).unwrap().len(), 2, "other tables are untouched");

        drop(conn);
        let reopened = init_db(&path).expect("reopening is a no-op");
        assert_eq!(crate::fabrication::revisions::list_recent(&reopened, 10).unwrap().len(), 5);
    }

    const SIGN_REVISION_COLUMNS: &str = "SELECT id, lineage_id, number, parent_id, title, spec_json, spec_sha256,
        requested_by, approval_status, approved_sha256, print_status, void_reason FROM sign_revisions ORDER BY id";

    /// A schema-5 database from the fixture at `dir/materialize.db`.
    fn schema_5_database(dir: &Path) -> std::path::PathBuf {
        let path = dir.join("materialize.db");
        Connection::open(&path).unwrap().execute_batch(include_str!("../tests/fixtures/db/main-schema-v5-signs.sql")).unwrap();
        path
    }

    fn backup_of(path: &Path) -> std::path::PathBuf {
        path.with_file_name("materialize.db.pre-schema-6")
    }

    #[test]
    fn migrating_a_schema_5_database_keeps_a_backup_with_its_sign_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let path = schema_5_database(dir.path());
        let before = revision_columns(&Connection::open(&path).unwrap(), SIGN_REVISION_COLUMNS);

        init_db(&path).expect("migrates");

        let backup = Connection::open(backup_of(&path)).expect("the backup beside the database");
        let version: i32 = backup.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, 5, "the backup is the database as it was before migration 006");
        assert_eq!(revision_columns(&backup, SIGN_REVISION_COLUMNS), before, "every sign revision, unchanged");
        assert!(!staged_of(&path).exists(), "the staged copy is gone once published");
    }

    thread_local! {
        static INTERRUPT_BACKUP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    /// When a test asks, cuts the staged copy short, as a write that stopped
    /// part way would leave it.
    pub(super) fn interrupt_backup_if_asked(staged: &Path) {
        if INTERRUPT_BACKUP.with(|ask| ask.replace(false)) {
            let file = std::fs::OpenOptions::new().write(true).open(staged).unwrap();
            let len = file.metadata().unwrap().len();
            file.set_len(len / 2).unwrap();
        }
    }

    fn staged_of(path: &Path) -> std::path::PathBuf {
        path.with_file_name("materialize.db.pre-schema-6.partial")
    }

    fn version_of(path: &Path) -> i32 {
        Connection::open(path).unwrap().pragma_query_value(None, "user_version", |row| row.get(0)).unwrap()
    }

    /// A copy cut short stops the migration without leaving anything under the
    /// backup's name, and the next launch makes a good copy and migrates.
    #[test]
    fn an_interrupted_backup_stops_the_migration_and_the_retry_backs_up_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let path = schema_5_database(dir.path());
        let before = revision_columns(&Connection::open(&path).unwrap(), SIGN_REVISION_COLUMNS);

        INTERRUPT_BACKUP.with(|ask| ask.set(true));
        let err = init_db(&path).err().expect("the migration stops");
        assert!(err.contains("could not back up the database"), "{err}");
        assert_eq!(version_of(&path), 5, "migration 006 did not run");
        assert!(backup_of(&path).symlink_metadata().is_err(), "nothing was published under the backup's name");

        init_db(&path).expect("the retry migrates");
        assert_eq!(version_of(&path), 6);
        let backup = Connection::open(backup_of(&path)).expect("backup");
        assert_eq!(revision_columns(&backup, SIGN_REVISION_COLUMNS), before, "the backup holds every sign revision");
        assert!(!staged_of(&path).exists(), "the stale staged copy is gone");
    }

    /// An empty database under the backup's name, as a failed copy used to
    /// leave, is not trusted: the migration stops and the file is left alone.
    #[test]
    fn an_existing_backup_that_does_not_match_stops_the_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = schema_5_database(dir.path());
        drop(Connection::open(backup_of(&path)).unwrap());
        let left = std::fs::read(backup_of(&path)).unwrap();

        let err = init_db(&path).err().expect("the migration stops");
        assert!(err.contains("is not a copy of this database"), "{err}");
        assert_eq!(version_of(&path), 5, "migration 006 did not run");
        assert_eq!(std::fs::read(backup_of(&path)).unwrap(), left, "the existing file is left alone");
    }

    /// A good copy from an earlier attempt is kept, never replaced.
    #[test]
    fn an_existing_backup_that_matches_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = schema_5_database(dir.path());
        std::fs::copy(&path, backup_of(&path)).unwrap();
        let earlier = std::fs::read(backup_of(&path)).unwrap();

        init_db(&path).expect("migrates");

        assert_eq!(version_of(&path), 6);
        assert_eq!(std::fs::read(backup_of(&path)).unwrap(), earlier, "the earlier copy is kept as it was");
    }

    #[test]
    fn migration_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // Run migrations twice — should not error
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // Tables still work after double migration
        let record = make_record("r1", "Benchy", "2026-03-15T11:00:00Z", "completed");
        insert_history(&conn, &record).unwrap();
        let item = get_history_item(&conn, "r1").unwrap();
        assert!(item.is_some());
    }

    #[test]
    fn wal_mode_active() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let conn = init_db(&db_path).unwrap();

        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn get_history_item_returns_none_for_missing() {
        let conn = test_db();
        let item = get_history_item(&conn, "nonexistent").unwrap();
        assert!(item.is_none());
    }

    #[test]
    fn insert_record_with_all_nulls() {
        let conn = test_db();
        let record = PrintHistoryRecord {
            id: "r-null".into(),
            model_name: "Minimal".into(),
            gcode_file: None,
            started_at: None,
            completed_at: "2026-03-15T12:00:00Z".into(),
            duration_seconds: None,
            status: "completed".into(),
            fail_reason: None,
            filament_grams: None,
            filament_meters: None,
            thumbnail_path: None,
            quality_profile: None,
        };
        insert_history(&conn, &record).unwrap();

        let item = get_history_item(&conn, "r-null").unwrap().unwrap();
        assert_eq!(item.model_name, "Minimal");
        assert!(item.gcode_file.is_none());
        assert!(item.started_at.is_none());
        assert!(item.duration_seconds.is_none());
        assert!(item.fail_reason.is_none());
    }

    // ─── Library Model Tests ──────────────────────────────────────────────────

    fn make_library_model(id: &str, name: &str, folder: &str, imported_at: &str) -> LibraryModel {
        LibraryModel {
            id: id.into(),
            model_name: name.into(),
            author: Some("TestAuthor".into()),
            source_url: Some("https://makerworld.com/model/123".into()),
            imported_at: imported_at.into(),
            thumbnail_url: Some("https://example.com/thumb.jpg".into()),
            file_path: Some("/tmp/model.stl".into()),
            folder_path: folder.into(),
            rating: Some(4.5),
            download_count: Some(1000),
            file_count: Some(3),
        }
    }

    #[test]
    fn migration_002_creates_library_models_table() {
        let conn = test_db();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // Verify table exists by inserting and querying
        let model = make_library_model("lm1", "Benchy", "/tmp/benchy", "2026-03-15T10:00:00Z");
        insert_library_model(&conn, &model).unwrap();

        let all = get_all_library_models(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].model_name, "Benchy");
    }

    #[test]
    fn library_crud_round_trip() {
        let conn = test_db();

        let model = make_library_model("lm1", "Benchy", "/tmp/benchy", "2026-03-15T10:00:00Z");
        insert_library_model(&conn, &model).unwrap();

        let all = get_all_library_models(&conn).unwrap();
        assert_eq!(all.len(), 1);
        let m = &all[0];
        assert_eq!(m.id, "lm1");
        assert_eq!(m.model_name, "Benchy");
        assert_eq!(m.author.as_deref(), Some("TestAuthor"));
        assert_eq!(m.source_url.as_deref(), Some("https://makerworld.com/model/123"));
        assert_eq!(m.imported_at, "2026-03-15T10:00:00Z");
        assert_eq!(m.folder_path, "/tmp/benchy");
        assert_eq!(m.rating, Some(4.5));
        assert_eq!(m.download_count, Some(1000));
        assert_eq!(m.file_count, Some(3));
    }

    #[test]
    fn library_get_all_returns_descending_order() {
        let conn = test_db();

        insert_library_model(
            &conn,
            &make_library_model("lm1", "First", "/tmp/first", "2026-03-15T09:00:00Z"),
        )
        .unwrap();
        insert_library_model(
            &conn,
            &make_library_model("lm2", "Second", "/tmp/second", "2026-03-15T10:00:00Z"),
        )
        .unwrap();
        insert_library_model(
            &conn,
            &make_library_model("lm3", "Third", "/tmp/third", "2026-03-15T11:00:00Z"),
        )
        .unwrap();

        let all = get_all_library_models(&conn).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].model_name, "Third");
        assert_eq!(all[1].model_name, "Second");
        assert_eq!(all[2].model_name, "First");
    }

    #[test]
    fn library_search_matching_and_non_matching() {
        let conn = test_db();

        insert_library_model(
            &conn,
            &make_library_model("lm1", "Benchy Boat", "/tmp/benchy", "2026-03-15T10:00:00Z"),
        )
        .unwrap();
        insert_library_model(
            &conn,
            &make_library_model("lm2", "Phone Stand", "/tmp/phone", "2026-03-15T11:00:00Z"),
        )
        .unwrap();
        insert_library_model(
            &conn,
            &make_library_model("lm3", "Benchpress Clip", "/tmp/bench", "2026-03-15T12:00:00Z"),
        )
        .unwrap();

        // "bench" matches "Benchy Boat" and "Benchpress Clip"
        let results = search_library_models(&conn, "bench").unwrap();
        assert_eq!(results.len(), 2);

        // No match
        let results = search_library_models(&conn, "nonexistent").unwrap();
        assert!(results.is_empty());

        // Exact match
        let results = search_library_models(&conn, "Phone Stand").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].model_name, "Phone Stand");
    }

    #[test]
    fn library_delete_removes_record() {
        let conn = test_db();

        let model = make_library_model("lm1", "Benchy", "/tmp/nonexistent_folder_xyz", "2026-03-15T10:00:00Z");
        insert_library_model(&conn, &model).unwrap();

        let deleted = delete_library_model(&conn, "lm1").unwrap();
        assert!(deleted);

        let all = get_all_library_models(&conn).unwrap();
        assert!(all.is_empty());

        // Deleting again returns false
        let deleted_again = delete_library_model(&conn, "lm1").unwrap();
        assert!(!deleted_again);
    }

    #[test]
    fn library_delete_removes_filesystem_folder() {
        let conn = test_db();
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("my_model");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("model.stl"), b"test").unwrap();

        let model = make_library_model("lm1", "Benchy", &folder.to_string_lossy(), "2026-03-15T10:00:00Z");
        insert_library_model(&conn, &model).unwrap();

        let deleted = delete_library_model(&conn, "lm1").unwrap();
        assert!(deleted);
        assert!(!folder.exists(), "folder should be removed after delete");
    }

    #[test]
    fn scan_with_missing_directory() {
        let conn = test_db();
        let missing_path = std::path::Path::new("/tmp/nonexistent_library_dir_xyz");

        let count = scan_library_filesystem(&conn, missing_path).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn scan_with_synthetic_metadata() {
        let conn = test_db();
        let dir = tempfile::tempdir().unwrap();
        let library_root = dir.path();

        // Create two model directories with metadata.json
        let model1_dir = library_root.join("benchy-1234");
        std::fs::create_dir_all(&model1_dir).unwrap();
        std::fs::write(
            model1_dir.join("metadata.json"),
            r#"{
                "importedAt": "2026-03-15T10:00:00Z",
                "sourceUrl": "https://makerworld.com/model/1234",
                "model": {
                    "title": "Benchy",
                    "author": "CreativeMaker",
                    "images": ["https://example.com/benchy.jpg"],
                    "rating": 4.8,
                    "downloadCount": 5000
                },
                "files": ["benchy.stl", "benchy_plate.3mf"]
            }"#,
        )
        .unwrap();

        let model2_dir = library_root.join("hook-5678");
        std::fs::create_dir_all(&model2_dir).unwrap();
        std::fs::write(
            model2_dir.join("metadata.json"),
            r#"{
                "importedAt": "2026-03-14T09:00:00Z",
                "sourceUrl": "https://makerworld.com/model/5678",
                "model": {
                    "title": "Wall Hook",
                    "author": "PrintMaster"
                },
                "files": ["hook.stl"]
            }"#,
        )
        .unwrap();

        let count = scan_library_filesystem(&conn, library_root).unwrap();
        assert_eq!(count, 2);

        let all = get_all_library_models(&conn).unwrap();
        assert_eq!(all.len(), 2);
        // Newest first
        assert_eq!(all[0].model_name, "Benchy");
        assert_eq!(all[1].model_name, "Wall Hook");

        // Verify fields mapped correctly
        let benchy = &all[0];
        assert_eq!(benchy.author.as_deref(), Some("CreativeMaker"));
        assert_eq!(benchy.source_url.as_deref(), Some("https://makerworld.com/model/1234"));
        assert_eq!(benchy.thumbnail_url.as_deref(), Some("https://example.com/benchy.jpg"));
        assert_eq!(benchy.rating, Some(4.8));
        assert_eq!(benchy.download_count, Some(5000));
        assert_eq!(benchy.file_count, Some(2));
    }

    #[test]
    fn scan_handles_malformed_metadata() {
        let conn = test_db();
        let dir = tempfile::tempdir().unwrap();
        let library_root = dir.path();

        // Valid model
        let good_dir = library_root.join("good-model");
        std::fs::create_dir_all(&good_dir).unwrap();
        std::fs::write(
            good_dir.join("metadata.json"),
            r#"{"importedAt": "2026-03-15T10:00:00Z", "model": {"title": "Good"}, "files": []}"#,
        )
        .unwrap();

        // Malformed JSON
        let bad_dir = library_root.join("bad-model");
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("metadata.json"), "not valid json {{{").unwrap();

        let count = scan_library_filesystem(&conn, library_root).unwrap();
        assert_eq!(count, 1, "should skip malformed and index only valid");

        let all = get_all_library_models(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].model_name, "Good");
    }

    #[test]
    fn scan_idempotent_on_relaunch() {
        let conn = test_db();
        let dir = tempfile::tempdir().unwrap();
        let library_root = dir.path();

        let model_dir = library_root.join("benchy");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(
            model_dir.join("metadata.json"),
            r#"{"importedAt": "2026-03-15T10:00:00Z", "model": {"title": "Benchy"}, "files": ["b.stl"]}"#,
        )
        .unwrap();

        let count1 = scan_library_filesystem(&conn, library_root).unwrap();
        assert_eq!(count1, 1);

        // Scan again — INSERT OR IGNORE should skip existing (folder_path UNIQUE)
        let _count2 = scan_library_filesystem(&conn, library_root).unwrap();
        // INSERT OR IGNORE succeeds without error but doesn't actually insert,
        // so indexed count will be 1 again (the INSERT "succeeds" but is ignored).
        // The important thing: total records is still 1.
        let all = get_all_library_models(&conn).unwrap();
        assert_eq!(all.len(), 1, "should not duplicate on rescan");
    }

    #[test]
    fn migration_002_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // Both tables work
        let record = make_record("r1", "Benchy", "2026-03-15T11:00:00Z", "completed");
        insert_history(&conn, &record).unwrap();

        let model = make_library_model("lm1", "Hook", "/tmp/hook", "2026-03-15T10:00:00Z");
        insert_library_model(&conn, &model).unwrap();
    }

    #[test]
    fn library_insert_or_ignore_on_duplicate_folder() {
        let conn = test_db();

        let model1 = make_library_model("lm1", "Original", "/tmp/same_folder", "2026-03-15T10:00:00Z");
        insert_library_model(&conn, &model1).unwrap();

        // Same folder_path, different id — should be silently ignored
        let model2 = make_library_model("lm2", "Duplicate", "/tmp/same_folder", "2026-03-15T11:00:00Z");
        insert_library_model(&conn, &model2).unwrap();

        let all = get_all_library_models(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].model_name, "Original");
    }

    // ─── Printer Config Tests ─────────────────────────────────────────────

    fn make_printer_config(id: &str, name: &str, host: &str, serial: &str) -> PrinterConfig {
        let now = "2026-03-15T10:00:00Z".to_string();
        PrinterConfig {
            id: id.into(),
            name: name.into(),
            host: host.into(),
            serial: serial.into(),
            access_code_keychain_id: format!("printer:{id}:access_code"),
            is_default: false,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    #[test]
    fn migration_003_creates_both_tables() {
        let conn = test_db();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // Verify printer_configs table exists
        let config = make_printer_config("pc1", "Test Printer", "10.0.0.1", "SERIAL1");
        insert_printer_config(&conn, &config).unwrap();
        let all = get_all_printer_configs(&conn).unwrap();
        assert_eq!(all.len(), 1);

        // Verify settings table exists
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["test_key", "test_value", "2026-03-15T10:00:00Z"],
        )
        .unwrap();

        let val: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params!["test_key"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, "test_value");
    }

    #[test]
    fn migration_003_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();

        // Run migrations twice — should not error
        run_migrations(&conn).unwrap();
        run_migrations(&conn).unwrap();

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // Tables still work after double migration
        let config = make_printer_config("pc1", "Printer", "10.0.0.1", "SN1");
        insert_printer_config(&conn, &config).unwrap();
        let fetched = get_printer_config(&conn, "pc1").unwrap();
        assert!(fetched.is_some());
    }

    #[test]
    fn printer_config_insert_and_get_round_trip() {
        let conn = test_db();
        let config = make_printer_config("pc1", "My P2S", "192.0.2.136", "01P00A000000000");
        insert_printer_config(&conn, &config).unwrap();

        let fetched = get_printer_config(&conn, "pc1").unwrap().unwrap();
        assert_eq!(fetched.id, "pc1");
        assert_eq!(fetched.name, "My P2S");
        assert_eq!(fetched.host, "192.0.2.136");
        assert_eq!(fetched.serial, "01P00A000000000");
        assert_eq!(fetched.access_code_keychain_id, "printer:pc1:access_code");
        assert!(!fetched.is_default);
        assert_eq!(fetched.created_at, "2026-03-15T10:00:00Z");
    }

    #[test]
    fn printer_config_update_modifies_fields() {
        let conn = test_db();
        let mut config = make_printer_config("pc1", "Original", "10.0.0.1", "SN1");
        insert_printer_config(&conn, &config).unwrap();

        config.name = "Updated Name".into();
        config.host = "192.168.1.100".into();
        config.serial = "NEWSN".into();
        config.updated_at = "2026-03-15T12:00:00Z".into();
        update_printer_config(&conn, &config).unwrap();

        let fetched = get_printer_config(&conn, "pc1").unwrap().unwrap();
        assert_eq!(fetched.name, "Updated Name");
        assert_eq!(fetched.host, "192.168.1.100");
        assert_eq!(fetched.serial, "NEWSN");
        assert_eq!(fetched.updated_at, "2026-03-15T12:00:00Z");
        // created_at unchanged
        assert_eq!(fetched.created_at, "2026-03-15T10:00:00Z");
    }

    #[test]
    fn printer_config_delete_removes_config() {
        let conn = test_db();
        let config = make_printer_config("pc1", "Printer", "10.0.0.1", "SN1");
        insert_printer_config(&conn, &config).unwrap();

        delete_printer_config(&conn, "pc1").unwrap();

        let fetched = get_printer_config(&conn, "pc1").unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn printer_config_delete_nonexistent_errors() {
        let conn = test_db();
        let result = delete_printer_config(&conn, "nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn printer_config_set_default_clears_previous() {
        let conn = test_db();

        let mut config1 = make_printer_config("pc1", "Printer 1", "10.0.0.1", "SN1");
        config1.is_default = true;
        insert_printer_config(&conn, &config1).unwrap();

        let config2 = make_printer_config("pc2", "Printer 2", "10.0.0.2", "SN2");
        insert_printer_config(&conn, &config2).unwrap();

        // Set pc2 as default — pc1 should lose default status
        set_default_printer_config(&conn, "pc2").unwrap();

        let fetched1 = get_printer_config(&conn, "pc1").unwrap().unwrap();
        let fetched2 = get_printer_config(&conn, "pc2").unwrap().unwrap();
        assert!(!fetched1.is_default);
        assert!(fetched2.is_default);
    }

    #[test]
    fn printer_config_set_default_nonexistent_errors() {
        let conn = test_db();
        let result = set_default_printer_config(&conn, "nonexistent");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn printer_config_get_all_returns_empty_for_fresh_db() {
        let conn = test_db();
        let all = get_all_printer_configs(&conn).unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn printer_config_get_all_ordered_by_name() {
        let conn = test_db();

        insert_printer_config(&conn, &make_printer_config("pc3", "Charlie", "10.0.0.3", "SN3")).unwrap();
        insert_printer_config(&conn, &make_printer_config("pc1", "Alpha", "10.0.0.1", "SN1")).unwrap();
        insert_printer_config(&conn, &make_printer_config("pc2", "Bravo", "10.0.0.2", "SN2")).unwrap();

        let all = get_all_printer_configs(&conn).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].name, "Alpha");
        assert_eq!(all[1].name, "Bravo");
        assert_eq!(all[2].name, "Charlie");
    }

    #[test]
    fn settings_table_accepts_key_value_pairs() {
        let conn = test_db();

        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["theme", "dark", "2026-03-15T10:00:00Z"],
        )
        .unwrap();

        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["language", "en", "2026-03-15T10:00:00Z"],
        )
        .unwrap();

        let val: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params!["theme"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, "dark");

        // Update existing key
        conn.execute(
            "UPDATE settings SET value = ?1, updated_at = ?2 WHERE key = ?3",
            params!["light", "2026-03-15T11:00:00Z", "theme"],
        )
        .unwrap();

        let val2: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params!["theme"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val2, "light");
    }

    #[test]
    fn printer_config_update_nonexistent_errors() {
        let conn = test_db();
        let config = make_printer_config("nonexistent", "Ghost", "10.0.0.1", "SN1");
        let result = update_printer_config(&conn, &config);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn printer_config_serde_round_trip() {
        let config = PrinterConfig {
            id: "test-id".into(),
            name: "My Printer".into(),
            host: "10.0.0.1".into(),
            serial: "SN123".into(),
            access_code_keychain_id: "printer:test-id:access_code".into(),
            is_default: true,
            created_at: "2026-03-15T10:00:00Z".into(),
            updated_at: "2026-03-15T10:00:00Z".into(),
        };

        let json = serde_json::to_string(&config).unwrap();
        let back: PrinterConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config, back);

        // Verify camelCase serialization
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value.get("accessCodeKeychainId").is_some());
        assert!(value.get("isDefault").is_some());
        assert!(value.get("createdAt").is_some());
    }

    // ─── Settings Tests ───────────────────────────────────────────────────

    #[test]
    fn test_settings_upsert_and_get() {
        let conn = test_db();
        upsert_setting(&conn, "theme", "dark").unwrap();

        let val = get_setting(&conn, "theme").unwrap();
        assert_eq!(val, Some("dark".to_string()));
    }

    #[test]
    fn test_settings_get_nonexistent_returns_none() {
        let conn = test_db();
        let val = get_setting(&conn, "nonexistent.key").unwrap();
        assert!(val.is_none());
    }

    #[test]
    fn test_settings_upsert_overwrite() {
        let conn = test_db();
        upsert_setting(&conn, "default.quality", "0.12").unwrap();
        upsert_setting(&conn, "default.quality", "0.28").unwrap();

        let val = get_setting(&conn, "default.quality").unwrap();
        assert_eq!(val, Some("0.28".to_string()));
    }

    #[test]
    fn test_settings_get_all_with_defaults() {
        let conn = test_db();
        // Store one override
        upsert_setting(&conn, "default.quality", "0.12").unwrap();

        let all = get_all_settings(&conn).unwrap();

        // Should have all 6 default keys
        assert_eq!(all.len(), 6);

        // Override should win
        assert_eq!(all.get("default.quality").unwrap(), "0.12");

        // Non-overridden defaults should be present
        assert_eq!(all.get("default.filament").unwrap(), "PLA Basic");
        assert_eq!(all.get("notifications.print_complete").unwrap(), "true");
        assert_eq!(all.get("notifications.print_failed").unwrap(), "true");
        assert_eq!(all.get("notifications.filament_low").unwrap(), "true");
        assert_eq!(all.get("connection.auto_connect").unwrap(), "false");
    }
}
