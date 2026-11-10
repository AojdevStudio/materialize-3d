mod bambu;
mod build_gate;
mod credentials;
#[cfg(feature = "e2e")]
mod e2e;
mod sidecar;
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
        .manage(studio::quit::QuitFlush::default())
        .invoke_handler(tauri::generate_handler![
            updater::update_check,
            updater::update_install,
            studio::files::studio_files,
            studio::files::studio_import_file,
            studio::files::studio_save_bytes,
            studio::files::studio_reveal,
            studio::files::studio_open_in_bambu,
            studio::files::studio_pop_out,
            studio::files::studio_file_version,
            studio::quit::studio_flush_started,
            studio::quit::studio_flush_failed,
            studio::quit::studio_flushed,
            studio::quit::studio_open_files_privacy,
            sidecar::sidecar,
        ])
        .setup(|app| {
            let main_window = app.config().app.windows.iter().find(|w| w.label == "main").ok_or("tauri.conf.json has no main window")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), main_window)?
                .on_navigation(studio::may_navigate)
                .build()?;
            sidecar::start(app.handle().clone());
            #[cfg(feature = "e2e")]
            e2e::start(app.handle())?;

            // The docked inspector shrinks the page; verification runs keep it closed.
            #[cfg(debug_assertions)]
            if std::env::var_os("M3D_E2E_PORT").is_none() {
                if let Some(window) = app.get_webview_window("main") {
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
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "main" => {
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
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main" => {
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

#[cfg(test)]
mod acl_tests {
    use std::collections::BTreeSet;

    fn quoted_names(text: &str) -> BTreeSet<String> {
        text.split('"').skip(1).step_by(2).map(str::to_owned).collect()
    }

    fn registered_commands() -> BTreeSet<String> {
        let source = include_str!("lib.rs");
        let start = source.find("generate_handler![").expect("handler list") + "generate_handler![".len();
        let list = &source[start..start + source[start..].find(']').expect("end of handler list")];
        list.split(',')
            .map(|entry| entry.trim().rsplit("::").next().unwrap_or_default().to_owned())
            .filter(|name| !name.is_empty())
            .collect()
    }

    #[test]
    fn manifest_and_main_capability_cover_exactly_the_registered_commands() {
        let registered = registered_commands();
        let build = include_str!("../build.rs");
        let manifest = quoted_names(&build[build.find("APP_COMMANDS: &[&str] = &[").expect("command list")..]);
        assert_eq!(manifest, registered, "build.rs APP_COMMANDS");
        let main: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).expect("json");
        let allowed: BTreeSet<String> = main["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(|p| p.as_str()?.strip_prefix("allow-").map(|c| c.replace('-', "_")))
            .collect();
        assert_eq!(allowed, registered, "capabilities/default.json allow- entries");
    }

    #[test]
    fn pop_out_windows_may_only_read_file_versions() {
        let pop_out: serde_json::Value = serde_json::from_str(include_str!("../capabilities/pop-out.json")).expect("json");
        assert_eq!(pop_out["webviews"], serde_json::json!(["pop-out-*"]));
        assert_eq!(pop_out["permissions"], serde_json::json!(["allow-studio-file-version"]));
    }
}
