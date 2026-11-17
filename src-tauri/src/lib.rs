mod bambu;
mod build_gate;
mod credentials;
#[cfg(feature = "e2e")]
mod e2e;
mod login_shell;
mod sidecar;
mod slice_requests;
mod studio;
mod updater;

use std::sync::Arc;

use tauri::Manager;

/// The one expansion of `generate_context!`: on macOS it embeds Info.plist as a
/// symbol, so a second expansion (the ACL tests) would not link.
fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    studio::register_protocol(tauri::Builder::default())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Arc::new(build_gate::BuildGate::default()))
        .manage(updater::PendingUpdate::default())
        .manage(sidecar::Sidecar::default())
        .manage(slice_requests::Slices::default())
        .manage(studio::quit::QuitFlush::default())
        .invoke_handler(tauri::generate_handler![
            updater::update_check,
            updater::update_install,
            studio::files::studio_files,
            studio::files::studio_reveal,
            studio::files::studio_open_in_bambu,
            studio::files::studio_pop_out,
            studio::files::studio_file_version,
            studio::files::studio_projects_folder,
            studio::files::studio_open_files_privacy,
            studio::setup::studio_slicer,
            studio::setup::bambu_last_used,
            studio::setup::studio_printers,
            studio::quit::studio_flush_started,
            studio::quit::studio_flush_failed,
            studio::quit::studio_flushed,
            sidecar::sidecar,
        ])
        .setup(|app| {
            let main_window = app.config().app.windows.iter().find(|w| w.label == studio::window::MAIN).ok_or("tauri.conf.json has no main window")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), main_window)?
                .on_navigation(studio::may_navigate)
                .build()?;
            sidecar::start(app.handle().clone());
            #[cfg(feature = "e2e")]
            e2e::start(app.handle())?;

            // The docked inspector shrinks the page; verification runs keep it closed.
            #[cfg(debug_assertions)]
            if std::env::var_os("M3D_E2E_PORT").is_none() {
                if let Some(window) = app.get_webview_window(studio::window::MAIN) {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .build(app_context())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // A normal quit, or the main window's close, first lets the window save the text it has not saved yet. A
            // restart for an update cannot be held, so it goes on as before.
            tauri::RunEvent::ExitRequested { api, code, .. } if code != Some(tauri::RESTART_EXIT_CODE) => {
                if studio::quit::QuitFlush::hold(app, move |app| app.exit(code.unwrap_or(0))) {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == studio::window::MAIN => {
                let closing = label.clone();
                if studio::quit::QuitFlush::hold(app, move |app| {
                    if let Some(window) = app.get_webview_window(&closing) {
                        let _ = window.destroy();
                    }
                }) {
                    api.prevent_close();
                }
            }
            // A pop out shows a file of the main window's project, so it closes with the main window, and the app quits as
            // before.
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == studio::window::MAIN => {
                for (other, window) in app.webview_windows() {
                    // A pop out that will not close stays until the person closes it, and the app quits with its last
                    // window, as Tauri does by default. The log records why it stayed.
                    if let Err(err) = window.destroy() {
                        log::warn!("studio: the {other} window did not close with the main one: {err}");
                    }
                }
            }
            // The sidecar finishes its commits and exits before the app does.
            tauri::RunEvent::Exit => app.state::<sidecar::Sidecar>().shutdown(),
            _ => {}
        });
}

/// Writes `body` to `path` as an executable script for a test to run. A shell writes the file, not this process. A
/// child that another test thread forks keeps a copy of every descriptor this process has open until the child execs,
/// and running a file that such a child holds open for writing fails with ETXTBSY ("Text file busy").
#[cfg(all(test, unix))]
fn write_test_script(path: &std::path::Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let status = std::process::Command::new("/bin/sh")
        .args(["-c", r#"printf '%s' "$1" > "$0""#])
        .arg(path)
        .arg(body)
        .status()
        .expect("start the script writer");
    assert!(status.success(), "writing {} failed: {status}", path.display());
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("make the script executable");
}

#[cfg(test)]
mod acl_tests {
    use std::collections::BTreeSet;

    use crate::studio::window::tests::{block, quoted, API_TS};
    use crate::studio::window::{MAIN, POP_OUT_PREFIX};

    fn registered_commands() -> BTreeSet<String> {
        block(include_str!("lib.rs"), "generate_handler![", "]")
            .split(',')
            .map(|entry| entry.trim().rsplit("::").next().unwrap_or_default().to_owned())
            .filter(|name| !name.is_empty())
            .collect()
    }

    fn capability(json: &str) -> serde_json::Value {
        serde_json::from_str(json).expect("json")
    }

    #[test]
    fn manifest_main_capability_and_window_cover_exactly_the_registered_commands() {
        let registered = registered_commands();
        assert_eq!(quoted(block(include_str!("../build.rs"), "APP_COMMANDS: &[&str] = &[", "]"), '"'), registered, "build.rs APP_COMMANDS");
        let allowed: BTreeSet<String> = capability(include_str!("../capabilities/default.json"))["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(|p| p.as_str()?.strip_prefix("allow-").map(|c| c.replace('-', "_")))
            .collect();
        assert_eq!(allowed, registered, "capabilities/default.json allow- entries");
        assert_eq!(quoted(block(API_TS, "const COMMANDS = [", "]"), '\''), registered, "src/studio/api.ts COMMANDS");
    }

    #[test]
    fn each_capability_names_its_window_by_the_label_rust_gives_it() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("json");
        assert_eq!(conf["app"]["windows"][0]["label"], MAIN, "tauri.conf.json");
        assert_eq!(capability(include_str!("../capabilities/default.json"))["webviews"], serde_json::json!([MAIN]));
        assert_eq!(capability(include_str!("../capabilities/pop-out.json"))["webviews"], serde_json::json!([format!("{POP_OUT_PREFIX}*")]));
    }

    #[test]
    fn pop_out_windows_may_only_read_file_versions() {
        let pop_out = capability(include_str!("../capabilities/pop-out.json"));
        assert_eq!(pop_out["webviews"], serde_json::json!(["pop-out-*"]));
        assert_eq!(pop_out["permissions"], serde_json::json!(["allow-studio-file-version"]));
    }
}
