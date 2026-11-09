//! In-app updates from the latest published GitHub release (issue #72).
//!
//! At launch the UI calls `update_check`. When the feed in `tauri.conf.json`
//! names a newer version, the person chooses **Update now** or **Later**.
//! Nothing installs without that click.
//!
//! `update_install` is the whole install, and the only way to install. It
//! downloads the archive, which the updater refuses unless its minisign
//! signature verifies against the public key in `tauri.conf.json` and was made
//! for the announced version. Then it waits until no work holds the gate
//! (issue #79): a sidecar turn or a slice. Only then does it replace the app
//! and restart. No work starts from the end of that wait to the restart. Any
//! failure leaves the running app as it was. The webview holds no updater
//! plugin permission, so it cannot install around the gate.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

use crate::build_gate::{BuildGate, Closed};

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

/// Installs the update the last check found once no work holds the gate, then restarts.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    gate: State<'_, Arc<BuildGate>>,
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
    let _closed = install_when_idle(&gate, waiting, || update.install(&bytes).map_err(|e| format!("The update did not install: {e}"))).await?;
    log::info!("updater: installed {}; restarting", update.version);
    app.restart()
}

/// Waits until no work holds the gate, then runs `install`. `waiting` hears how
/// many passes are held at each check. Work is refused from the end of the wait
/// until `install` fails, or until the returned guard drops. The caller holds it
/// through the restart.
pub(crate) async fn install_when_idle(
    gate: &BuildGate,
    waiting: impl FnMut(usize),
    install: impl FnOnce() -> Result<(), String>,
) -> Result<Closed<'_>, String> {
    let closed = gate.close_when_idle(waiting).await;
    install()?;
    Ok(closed)
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

    #[tokio::test]
    async fn running_work_holds_the_install_and_restart_until_it_ends() {
        let gate = BuildGate::default();
        let work = BuildGate::enter_owned(&gate).expect("work starts");
        let installed = AtomicBool::new(false);
        let mut update = std::pin::pin!(install_when_idle(&gate, |_| {}, || {
            installed.store(true, Ordering::SeqCst);
            Ok(())
        }));
        let wait = std::time::Duration::from_millis(100);
        assert!(tokio::time::timeout(wait, &mut update).await.is_err(), "the update waits while the work runs");
        assert!(!installed.load(Ordering::SeqCst), "nothing installs while work runs");
        drop(work);
        let _installed =
            tokio::time::timeout(wait, &mut update).await.expect("the update goes ahead once the work ends").expect("installed");
        assert!(installed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn no_work_starts_from_the_install_until_the_restart() {
        let gate = BuildGate::default();
        let _installed = install_when_idle(&gate, |_| {}, || {
            assert!(BuildGate::enter_owned(&gate).is_none(), "no work starts between the idle check and the install");
            Ok(())
        })
        .await
        .expect("installed");
        assert!(BuildGate::enter_owned(&gate).is_none(), "the restart would cut off work that starts now");
    }

    #[tokio::test]
    async fn a_failed_install_lets_work_start_again() {
        let gate = BuildGate::default();
        let error = install_when_idle(&gate, |_| {}, || Err("disk full".into())).await.expect_err("install fails");
        assert_eq!(error, "disk full");
        assert!(BuildGate::enter_owned(&gate).is_some(), "the app runs on and work starts again");
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
