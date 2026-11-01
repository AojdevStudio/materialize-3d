//! In-app updates from the latest published GitHub release (issue #72).
//!
//! At launch the UI calls `update_check`. When the feed in `tauri.conf.json`
//! names a newer version, the person chooses **Update now** or **Later**.
//! Nothing installs without that click.
//!
//! `update_install` is the whole install, and the only way to install. It
//! downloads the archive, which the updater refuses unless its minisign
//! signature verifies against the public key in `tauri.conf.json` and was made
//! for the announced version. Then it waits until no build runs (issue #79),
//! backs up the database and print queue to
//! `<app data>/backups/<from>-to-<to>-<time>/`, and only after a checked backup
//! does it replace the app and restart. No build starts from the end of that
//! wait to the restart. Any failure leaves the running app as it was. The
//! webview holds no updater plugin permission, so it cannot install without
//! the backup.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::fabrication::build_gate::Closed;
use crate::state::AppState;

/// The update the last check found, kept for `update_install`.
#[derive(Default)]
pub struct PendingUpdate(tokio::sync::Mutex<Option<Update>>);

/// What a check found, as the UI reads it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateCheck {
    #[serde(rename_all = "camelCase")]
    UpToDate { current_version: String },
    #[serde(rename_all = "camelCase")]
    Available {
        current_version: String,
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
}

/// Download progress, sent to the main webview while an update downloads.
pub const PROGRESS_EVENT: &str = "update:progress";

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// How many builds a downloaded update is waiting for, sent at each check. 0 means it installs now.
pub const WAITING_EVENT: &str = "update:waiting";

/// Bytes between two progress events, so a large archive does not flood the UI.
const PROGRESS_STEP: u64 = 1 << 20;

/// How long a feed check may take. The download has no deadline, because the archive is large.
const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

fn updater<R: Runtime>(app: &AppHandle<R>) -> Result<Updater, String> {
    let builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    // The verification harness points debug builds at a local test feed. Release builds never compile this.
    #[cfg(debug_assertions)]
    let builder = match std::env::var("M3D_E2E_UPDATE_FEED") {
        Ok(feed) => builder
            .endpoints(vec![feed.parse().map_err(|e| format!("M3D_E2E_UPDATE_FEED: {e}"))?])
            .map_err(|e| format!("M3D_E2E_UPDATE_FEED: {e}"))?,
        Err(_) => builder,
    };
    builder.build().map_err(|e| format!("Could not set up the updater: {e}"))
}

pub(crate) fn describe(current_version: &str, found: Option<&Update>) -> UpdateCheck {
    match found {
        None => UpdateCheck::UpToDate { current_version: current_version.to_owned() },
        Some(update) => UpdateCheck::Available {
            current_version: current_version.to_owned(),
            version: update.version.clone(),
            notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
            date: update.raw_json.get("pub_date").and_then(|date| date.as_str()).map(str::to_owned),
        },
    }
}

/// Asks the feed for a newer release. Only a version above the running one counts.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let found = updater(&app)?
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?;
    let check = describe(&current_version, found.as_ref());
    log::info!("updater: checked the feed, {check:?}");
    *pending.0.lock().await = found;
    Ok(check)
}

/// Installs the update the last check found once no build runs, after a checked backup, then restarts.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    pending: State<'_, PendingUpdate>,
    version: String,
) -> Result<(), String> {
    // Held to the end, so a second click waits for this one instead of installing twice.
    let slot = pending.0.lock().await;
    let update = slot
        .as_ref()
        .filter(|update| update.version == version)
        .ok_or_else(|| format!("Version {version} is not ready to install. Check for updates again."))?;
    log::info!("updater: installing {} over {}", update.version, update.current_version);

    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if downloaded - reported >= PROGRESS_STEP || total == Some(downloaded) {
                    reported = downloaded;
                    if let Err(e) = app.emit(PROGRESS_EVENT, Progress { downloaded, total }) {
                        log::warn!("updater: could not report download progress: {e}");
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| format!("The update did not download or its signature did not verify: {e}"))?;

    let waiting = |builds: usize| {
        if let Err(e) = app.emit(WAITING_EVENT, builds) {
            log::warn!("updater: could not report the builds it waits for: {e}");
        }
    };
    let (backup, _closed) = install_when_idle(&state, &update.current_version, &update.version, waiting, || {
        update.install(&bytes).map_err(|e| format!("The update did not install: {e}"))
    })
    .await?;
    log::info!("updater: installed {}, backup at {}; restarting", update.version, backup.display());
    app.restart()
}

/// Waits until no build runs, backs up the database and print queue, then runs
/// `install` only if the backup is complete and checked. `waiting` hears how many
/// builds are running at each check. Builds are refused from the end of the wait
/// until this fails, or until the returned guard drops. The caller holds it
/// through the restart.
///
/// The locks are held for the backup only. On macOS the install can ask for an
/// administrator's approval on the main thread, and a command waiting there for
/// one of these locks would deadlock it. A write between the backup and the
/// restart stays in the live database, not in the backup.
pub(crate) async fn install_when_idle<'a>(
    state: &'a AppState,
    from: &str,
    to: &str,
    waiting: impl FnMut(usize),
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(PathBuf, Closed<'a>), String> {
    let closed = state.builds.close_when_idle(waiting).await;
    let backup = {
        let db = state.db.lock().map_err(|e| format!("Did not update: the database lock failed: {e}"))?;
        let conn = db.as_ref().ok_or("Did not update: the database is not open")?;
        let _queue = state
            .print_queue
            .lock()
            .map_err(|e| format!("Did not update: the print queue lock failed: {e}"))?;
        back_up(conn, state.print_queue_file.as_deref(), from, to)
            .map_err(|e| format!("Did not update, because the backup failed: {e}"))?
    };
    log::info!("updater: backed up the app data to {}", backup.display());
    install().map_err(|e| format!("{e}. Your data was backed up to {} first.", backup.display()))?;
    Ok((backup, closed))
}

/// Writes `backups/<from>-to-<to>-<time>/` beside the live database: a
/// `VACUUM INTO` copy of it (one file, WAL included) that must pass an
/// integrity check at the same schema version, and a copy of the print queue
/// file when one exists. A failed backup removes its folder.
fn back_up(conn: &Connection, queue_file: Option<&Path>, from: &str, to: &str) -> Result<PathBuf, String> {
    for version in [from, to] {
        if version.is_empty() || !version.bytes().all(|b| b.is_ascii_alphanumeric() || b".+-".contains(&b)) {
            return Err(format!("{version:?} is not a version"));
        }
    }
    let live = conn.path().filter(|path| !path.is_empty()).ok_or("the database has no file")?;
    let root = Path::new(live).parent().ok_or("the database has no folder")?.join("backups");
    let dir = root.join(format!("{from}-to-{to}-{}", chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")));
    std::fs::create_dir_all(&root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    // `create_dir`, not `create_dir_all`: cleaning up must never remove another run's folder.
    std::fs::create_dir(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let written = write_backup(conn, queue_file, &dir);
    if let Err(why) = written {
        return Err(match std::fs::remove_dir_all(&dir) {
            Ok(()) => why,
            Err(e) => format!("{why}; the incomplete {} could not be removed: {e}", dir.display()),
        });
    }
    Ok(dir)
}

fn write_backup(conn: &Connection, queue_file: Option<&Path>, dir: &Path) -> Result<(), String> {
    let copy = dir.join("materialize.db");
    conn.execute("VACUUM INTO ?1", [copy.to_string_lossy()])
        .map_err(|e| format!("could not copy the database: {e}"))?;
    let schema = |conn: &Connection| conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0));
    let expected = schema(conn).map_err(|e| format!("could not read the schema version: {e}"))?;
    let check = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("could not open the copy: {e}"))?;
    let integrity: String = check
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|e| format!("could not check the copy: {e}"))?;
    if integrity != "ok" {
        return Err(format!("the copy failed its integrity check: {integrity}"));
    }
    let copied = schema(&check).map_err(|e| format!("could not read the copy's schema version: {e}"))?;
    if copied != expected {
        return Err(format!("the copy is at schema {copied}, the database at {expected}"));
    }
    if let Some(queue) = queue_file.filter(|queue| queue.exists()) {
        std::fs::copy(queue, dir.join("print_queue.json"))
            .map_err(|e| format!("could not copy the print queue {}: {e}", queue.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    use super::*;

    /// Throwaway minisign keys made for these tests with `tauri signer generate`.
    /// The private halves were never kept.
    const KEY_A: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDRGNEY4QzMzNzkzNTk4NjgKUldSb21EVjVNNHhQVDg1SXZMOEJrbEd3dXY5a0xhVHJJRnhlbStjWEh3Q2NqSXBCVnVOWFZuRTAK";
    const KEY_B: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQwRDIwMzk2MDQwRDAwMjAKUldRZ0FBMEVsZ1BTMExOMDUvNDd5NU4zMVFwcHZzbVlNTUQ3bXZIVlBKRHVadjVROHdxTVhiZzUK";
    /// `ARCHIVE` signed with key A by `tauri signer sign --app-version 9.9.9`.
    const ARCHIVE: &[u8] = b"materialize-3d updater test archive\n";
    const ARCHIVE_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSb21EVjVNNHhQVHdsMDlKMzNrVkFJN1VNNU52cWRYbFhRbnFDdndxNUlUZXcxSFNzd0pucjVYeDBYRlpWSjFjNVZjQzk3eTQrK2d3aDBQZnNMbWF0cmljclRKSFFLQXdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzNDg4NTk5CWZpbGU6cGF5bG9hZC5iaW4JdmVyc2lvbjo5LjkuOQp6RVJEMk1RVWh4Y21kZDJ1RXNSczZuNktzeFh4bmJWZmxmQ3drOUYybzd6WTlQeTVrWjVnN0tVS0JmMW5OWmkzN1hyQ1AveUxGQjA5MVFqN2hLTVJBZz09Cg==";
    const SIGNED_VERSION: &str = "9.9.9";

    /// Serves `latest.json` announcing `version` for the `test` target, and the archive bytes.
    async fn feed(version: &str, archive: &'static [u8]) -> url::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let latest = serde_json::json!({
            "version": version,
            "notes": "What changed",
            "pub_date": "2026-11-01T12:00:00Z",
            "platforms": { "test": { "signature": ARCHIVE_SIG, "url": format!("{base}/archive.tar.gz") } },
        });
        let router = axum::Router::new()
            .route("/latest.json", axum::routing::get(move || async move { axum::Json(latest) }))
            .route("/archive.tar.gz", axum::routing::get(move || async move { archive }));
        tokio::spawn(async move { axum::serve(listener, router).await.expect("serve") });
        format!("{base}/latest.json").parse().expect("url")
    }

    /// A mock app whose updater runs with the shipped `plugins.updater` config, except for the key.
    fn app(pubkey: &str) -> tauri::App<MockRuntime> {
        let shipped: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let mut context = mock_context(noop_assets());
        context.config_mut().plugins.0.insert("updater".into(), shipped["plugins"]["updater"].clone());
        mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().target("test").pubkey(pubkey).build())
            .build(context)
            .expect("mock app")
    }

    async fn check(app: &tauri::App<MockRuntime>, feed: url::Url) -> Option<Update> {
        let updater = app.updater_builder().endpoints(vec![feed]).expect("endpoint").build().expect("updater");
        updater.check().await.expect("check")
    }

    fn current(app: &tauri::App<MockRuntime>) -> String {
        app.package_info().version.to_string()
    }

    #[test]
    fn the_shipped_feed_is_the_latest_github_release_and_requires_signed_versions() {
        let shipped: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let updater = &shipped["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            serde_json::json!(["https://github.com/AojdevStudio/materialize-3d/releases/latest/download/latest.json"])
        );
        assert_eq!(updater["requireSignedVersion"], true);
        assert!(updater.get("dangerousInsecureTransportProtocol").is_none());
    }

    #[tokio::test]
    async fn a_newer_version_is_offered_with_its_notes_and_date() {
        let app = app(KEY_A);
        let found = check(&app, feed(SIGNED_VERSION, ARCHIVE).await).await;
        assert_eq!(
            describe(&current(&app), found.as_ref()),
            UpdateCheck::Available {
                current_version: current(&app),
                version: SIGNED_VERSION.into(),
                notes: Some("What changed".into()),
                date: Some("2026-11-01T12:00:00Z".into()),
            }
        );
    }

    #[tokio::test]
    async fn the_same_or_an_older_version_is_not_offered() {
        let app = app(KEY_A);
        for version in [current(&app), "0.0.1".to_owned()] {
            let found = check(&app, feed(&version, ARCHIVE).await).await;
            assert!(found.is_none(), "{version} must not be offered over {}", current(&app));
            assert_eq!(describe(&current(&app), None), UpdateCheck::UpToDate { current_version: current(&app) });
        }
    }

    #[tokio::test]
    async fn an_archive_with_a_good_signature_downloads() {
        let app = app(KEY_A);
        let update = check(&app, feed(SIGNED_VERSION, ARCHIVE).await).await.expect("offered");
        assert_eq!(update.download(|_, _| {}, || {}).await.expect("verified"), ARCHIVE);
    }

    #[tokio::test]
    async fn an_archive_signed_by_another_key_is_refused() {
        let app = app(KEY_B);
        let update = check(&app, feed(SIGNED_VERSION, ARCHIVE).await).await.expect("offered");
        assert!(update.download(|_, _| {}, || {}).await.is_err());
    }

    #[tokio::test]
    async fn an_archive_changed_after_signing_is_refused() {
        let app = app(KEY_A);
        let update = check(&app, feed(SIGNED_VERSION, b"materialize-3d updater test archive, changed\n").await)
            .await
            .expect("offered");
        assert!(update.download(|_, _| {}, || {}).await.is_err());
    }

    #[tokio::test]
    async fn a_signature_made_for_another_version_is_refused() {
        // A feed that pairs a higher version with an older release's archive and signature.
        let app = app(KEY_A);
        let update = check(&app, feed("10.0.0", ARCHIVE).await).await.expect("offered");
        assert!(update.download(|_, _| {}, || {}).await.is_err());
    }

    #[tokio::test]
    async fn a_failed_check_is_an_error() {
        let app = app(KEY_A);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let closed = format!("http://{}/latest.json", listener.local_addr().expect("addr"));
        drop(listener);
        let updater = app.updater_builder().endpoints(vec![closed.parse().expect("url")]).expect("endpoint").build().expect("updater");
        assert!(updater.check().await.is_err());
    }

    fn state_in(dir: &Path) -> AppState {
        let state = AppState { print_queue_file: Some(dir.join("print_queue.json")), ..AppState::default() };
        let conn = crate::database::init_db(&dir.join("materialize.db")).expect("db");
        crate::database::upsert_setting(&conn, "connection.auto_connect", "true").expect("setting");
        *state.db.lock().expect("db") = Some(conn);
        std::fs::write(dir.join("print_queue.json"), "[]").expect("queue");
        state
    }

    #[tokio::test]
    async fn a_checked_backup_comes_before_the_install() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = state_in(dir.path());
        let (backup, _closed) = install_when_idle(&state, "0.2.1", "0.3.0", |_| {}, || {
            let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups")).expect("backups").collect();
            assert_eq!(backups.len(), 1, "the backup exists before the install runs");
            assert!(state.db.try_lock().is_ok() && state.print_queue.try_lock().is_ok(), "the install runs unlocked");
            assert!(state.builds.enter().is_none(), "no build starts between the idle check and the restart");
            Ok(())
        })
        .await
        .expect("installed");
        let backups = dir.path().canonicalize().expect("canonical").join("backups");
        assert_eq!(backup.parent(), Some(backups.as_path()), "the backup sits in the app data folder");
        assert!(backup.file_name().expect("name").to_string_lossy().starts_with("0.2.1-to-0.3.0-"));
        let copy = Connection::open(backup.join("materialize.db")).expect("copy");
        assert_eq!(crate::database::get_setting(&copy, "connection.auto_connect").expect("read"), Some("true".into()));
        assert_eq!(std::fs::read_to_string(backup.join("print_queue.json")).expect("queue"), "[]");
    }

    #[tokio::test]
    async fn a_running_build_holds_the_install_and_restart_until_it_ends() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = state_in(dir.path());
        let build = state.builds.enter().expect("a build starts");
        let installed = AtomicBool::new(false);
        let mut update = std::pin::pin!(install_when_idle(&state, "0.2.1", "0.3.0", |_| {}, || {
            installed.store(true, Ordering::SeqCst);
            Ok(())
        }));
        let wait = std::time::Duration::from_millis(100);
        assert!(tokio::time::timeout(wait, &mut update).await.is_err(), "the update waits while the build runs");
        assert!(!installed.load(Ordering::SeqCst), "nothing installs while a build runs");
        drop(build);
        let _installed =
            tokio::time::timeout(wait, &mut update).await.expect("the update goes ahead once the build ends").expect("installed");
        assert!(installed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn no_build_starts_after_the_install_until_the_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = state_in(dir.path());
        let _installed = install_when_idle(&state, "0.2.1", "0.3.0", |_| {}, || Ok(())).await.expect("installed");
        assert!(state.builds.enter().is_none(), "the restart would kill a build that starts now");
    }

    #[tokio::test]
    async fn a_failed_backup_stops_the_install() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = state_in(dir.path());
        std::fs::write(dir.path().join("backups"), "a file where the backups folder goes").expect("block");
        let installed = AtomicBool::new(false);
        let error = install_when_idle(&state, "0.2.1", "0.3.0", |_| {}, || {
            installed.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await
        .expect_err("the backup must fail");
        assert!(!installed.load(Ordering::SeqCst), "nothing installs without a backup");
        assert!(error.contains("backup failed"), "{error}");
        assert!(state.builds.enter().is_some(), "the app runs on and builds again");
    }

    #[tokio::test]
    async fn a_failed_install_names_the_backup_it_kept_and_lets_builds_start_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = state_in(dir.path());
        let error = install_when_idle(&state, "0.2.1", "0.3.0", |_| {}, || Err("disk full".into()))
            .await
            .expect_err("install fails");
        assert!(error.starts_with("disk full. Your data was backed up to"), "{error}");
        assert!(state.builds.enter().is_some(), "the app runs on and builds again");
    }

    #[test]
    fn the_webview_cannot_call_the_updater_plugin_directly() {
        let mut context = crate::app_context();
        let authority = context.runtime_authority_mut();
        for command in ["check", "download", "install", "download_and_install"] {
            let command = format!("plugin:updater|{command}");
            assert!(
                authority.resolve_access(&command, "main", "main", &tauri::ipc::Origin::Local).is_none(),
                "the main webview must install only through update_install, not {command}"
            );
        }
    }
}
