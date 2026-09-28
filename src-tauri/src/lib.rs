mod commands;
mod credentials;
mod database;
mod makerworld;
mod oauth_callback;
pub mod fabrication;
pub mod openscad;
pub mod platform;
mod print_queue;
/// Exposed for integration tests only.
#[doc(hidden)]
pub mod printer;
pub mod slicer;
/// Exposed for integration tests only.
#[doc(hidden)]
pub mod state;

use std::sync::Arc;

use commands::{
    add_printer_config, add_to_queue, connect_printer, connect_printer_by_config,
    delete_credential, delete_print_history_item, delete_printer_config, disconnect_printer,
    download_model, get_app_state, get_credential, get_designs_dir, get_print_history,
    get_printer_configs, get_printer_status, get_queue, get_settings, has_credential,
    list_profiles, makerworld_back, makerworld_forward, makerworld_reload, navigate_makerworld,
    pause_print, probe_camera, read_model_file, read_text_file, remove_from_queue,
    report_makerworld_import_attempt, report_makerworld_page, resume_print, search_makerworld,
    set_active_view, set_default_printer, slice_model, start_oauth_callback, start_print,
    stop_oauth_callback, store_credential, switch_printer, sync_makerworld_webview,
    oauth_token_exchange, update_printer_config, update_settings, write_text_file,
    get_library_models, search_library_models, delete_library_model, open_library_model,
    openscad_check_installed, openscad_extract_params, openscad_render,
};
use makerworld::MakerWorldService;
use oauth_callback::OAuthCallbackState;
use openscad::OpenScadService;
use printer::PrinterService;
use slicer::SlicerService;
use state::AppState;
use tauri::Manager;

/// The one expansion of `generate_context!`: on macOS it embeds Info.plist as a
/// symbol, so a second expansion (the ACL tests) would not link.
fn app_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(AppState::default()))
        .manage(PrinterService::new())
        .manage(MakerWorldService::default())
        .manage(SlicerService::default())
        .manage(OpenScadService::default())
        .manage(OAuthCallbackState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            set_active_view,
            sync_makerworld_webview,
            navigate_makerworld,
            search_makerworld,
            makerworld_back,
            makerworld_forward,
            makerworld_reload,
            download_model,
            report_makerworld_page,
            report_makerworld_import_attempt,
            connect_printer,
            disconnect_printer,
            get_printer_status,
            probe_camera,
            pause_print,
            resume_print,
            start_print,
            list_profiles,
            slice_model,
            read_model_file,
            read_text_file,
            write_text_file,
            add_to_queue,
            get_queue,
            remove_from_queue,
            get_print_history,
            delete_print_history_item,
            get_library_models,
            search_library_models,
            delete_library_model,
            open_library_model,
            openscad_check_installed,
            openscad_extract_params,
            openscad_render,
            get_designs_dir,
            store_credential,
            get_credential,
            delete_credential,
            has_credential,
            start_oauth_callback,
            stop_oauth_callback,
            oauth_token_exchange,
            add_printer_config,
            update_printer_config,
            delete_printer_config,
            get_printer_configs,
            set_default_printer,
            connect_printer_by_config,
            switch_printer,
            get_settings,
            update_settings,
        ])
        .setup(|app| {
            // Initialize SQLite database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
            let db_path = app_data_dir.join("materialize.db");

            let app_state = app.state::<Arc<AppState>>();
            let conn = database::init_db(&db_path)
                .map_err(|e| format!("database init failed: {e}"))?;
            {
                let mut db_guard = app_state
                    .db
                    .lock()
                    .map_err(|e| format!("failed to lock db mutex: {e}"))?;
                *db_guard = Some(conn);
            }
            log::info!("setup: SQLite database initialized at {}", db_path.display());

            // Scan library filesystem for existing metadata.json files
            let library_root = app_data_dir.join("library").join("makerworld");
            {
                let db_guard = app_state
                    .db
                    .lock()
                    .map_err(|e| format!("failed to lock db for library scan: {e}"))?;
                if let Some(conn) = db_guard.as_ref() {
                    match database::scan_library_filesystem(conn, &library_root) {
                        Ok(count) => {
                            log::info!("setup: library scan complete — indexed {count} new models");
                        }
                        Err(e) => {
                            log::error!("setup: library scan failed: {e}");
                        }
                    }
                }
            }

            // Initialize print queue from persisted file
            print_queue::init_queue(&app_state);

            // Auto-connect: if enabled, spawn background connection to default printer
            {
                let db_guard = app_state
                    .db
                    .lock()
                    .map_err(|e| format!("failed to lock db for auto-connect check: {e}"))?;
                if let Some(conn) = db_guard.as_ref() {
                    let auto_connect = database::get_setting(conn, "connection.auto_connect")
                        .unwrap_or(None)
                        .unwrap_or_else(|| "false".to_string());

                    if auto_connect == "true" {
                        // Find the default printer config
                        let configs = database::get_all_printer_configs(conn).unwrap_or_default();
                        let default_config = configs.into_iter().find(|c| c.is_default);

                        match default_config {
                            Some(config) => {
                                let config_id = config.id.clone();
                                log::info!("auto-connect:attempt config_id={}", config_id);

                                let app_handle = app.handle().clone();
                                let state_arc = std::sync::Arc::clone(&*app_state);
                                let printer_service = app.state::<PrinterService>().inner().clone();

                                tokio::spawn(async move {
                                    if let Err(e) = commands::connect_printer_by_config_inner(
                                        &config_id,
                                        &app_handle,
                                        &state_arc,
                                        &printer_service,
                                    ).await {
                                        log::error!("auto-connect:failed {e}");
                                    }
                                });
                            }
                            None => {
                                log::info!("auto-connect:no-default-config");
                            }
                        }
                    } else {
                        log::info!("auto-connect:disabled");
                    }
                }
            }

            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }
            Ok(())
        })
        .run(app_context())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod acl_tests {
    use std::collections::BTreeSet;

    use tauri::ipc::Origin;

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
    fn the_remote_makerworld_page_can_only_report_to_the_app() {
        let mut context = super::app_context();
        let authority = context.runtime_authority_mut();
        let makerworld = Origin::Remote { url: "https://makerworld.com/en/models/1".parse().expect("url") };
        for command in registered_commands() {
            let from_main = authority.resolve_access(&command, "main", "main", &Origin::Local);
            assert!(from_main.is_some(), "main webview must be allowed {command}");
            let from_makerworld = authority.resolve_access(&command, "main", "makerworld", &makerworld);
            let expected = matches!(command.as_str(), "report_makerworld_page" | "report_makerworld_import_attempt");
            assert_eq!(from_makerworld.is_some(), expected, "makerworld access to {command}");
        }
        // Core plugin commands the main webview keeps, the remote page must not
        // reach: the app event bus, window and webview control, app metadata.
        for command in [
            "plugin:event|listen",
            "plugin:event|emit",
            "plugin:event|emit_to",
            "plugin:window|scale_factor",
            "plugin:webview|get_all_webviews",
            "plugin:app|version",
        ] {
            assert!(authority.resolve_access(command, "main", "main", &Origin::Local).is_some(), "main webview must be allowed {command}");
            assert!(
                authority.resolve_access(command, "main", "makerworld", &makerworld).is_none(),
                "makerworld must not reach {command}"
            );
        }
    }
}
