mod commands;
mod credentials;
mod database;
pub mod actions;
#[cfg(test)]
mod caller_identity_tests;
pub mod agent;
pub mod fabrication;
#[cfg(feature = "e2e")]
mod e2e;
mod mcp;
mod studio_commands;
pub mod tools;
mod makerworld;
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
    set_active_view, set_default_printer, slice_model, start_print,
    store_credential, switch_printer, sync_makerworld_webview,
    update_printer_config, update_settings, write_text_file,
    get_library_models, search_library_models, delete_library_model, open_library_model,
    openscad_check_installed, openscad_extract_params, openscad_render,
};
use makerworld::MakerWorldService;
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
        .manage(agent::commands::AgentTurns::default())
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
            mcp::mcp_status,
            mcp::mcp_set_enabled,
            mcp::mcp_token,
            mcp::mcp_rotate_token,
            actions::gui::sign_build,
            actions::gui::sign_cancel,
            actions::gui::sign_list,
            actions::gui::sign_lineage,
            actions::gui::sign_get,
            actions::gui::sign_preview,
            actions::gui::sign_approve,
            actions::gui::sign_export,
            actions::gui::sign_record_print,
            agent::commands::agent_status,
            agent::commands::agent_set_api_key,
            agent::commands::agent_clear_api_key,
            agent::commands::agent_set_model,
            agent::commands::agent_history,
            agent::commands::agent_new_conversation,
            agent::commands::agent_send,
            agent::commands::agent_cancel,
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
            add_printer_config,
            update_printer_config,
            delete_printer_config,
            get_printer_configs,
            set_default_printer,
            connect_printer_by_config,
            switch_printer,
            get_settings,
            update_settings,
            studio_commands::bambu_studio_status,
            studio_commands::choose_bambu_studio,
            studio_commands::clear_bambu_studio,
        ])
        .setup(|app| {
            // Initialize SQLite database
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
            // Verification runs keep their state out of the person's real app data.
            #[cfg(feature = "e2e")]
            let app_data_dir = std::env::var_os("M3D_E2E_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(app_data_dir);
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

            // A build that was running when the app stopped can never finish;
            // record it as failed and remove its directory.
            let app_cache_dir = app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("failed to resolve app cache dir: {e}"))?;
            #[cfg(feature = "e2e")]
            let app_cache_dir = std::env::var_os("M3D_E2E_DATA_DIR")
                .map(|dir| std::path::PathBuf::from(dir).join("cache"))
                .unwrap_or(app_cache_dir);
            let workspace = fabrication::pipeline::Workspace::new(&app_data_dir, &app_cache_dir);
            let cleanup = fabrication::pipeline::reconcile_startup(&app_state, &workspace)
                .map_err(|e| format!("sign build reconcile failed: {e}"))?;
            log::info!(
                "setup: signs reconciled ({} interrupted builds, {} unfinished build dirs removed)",
                cleanup.interrupted,
                cleanup.removed_dirs
            );

            // An agent tool call that was running when the app stopped is
            // shown as interrupted and never re-run.
            let interrupted_calls = agent::store::with_conn(&app_state, |conn| agent::store::reconcile_interrupted(conn))
                .map_err(|e| format!("agent tool call reconcile failed: {e}"))?;
            log::info!("setup: agent reconciled ({interrupted_calls} interrupted tool calls)");
            #[cfg(feature = "e2e")]
            e2e::start(app.handle())?;
            let app_actions =
                actions::Actions::new(actions::gui::app_events(app.handle().clone()), app_state.inner().clone(), workspace);
            // The GUI commands use `Actions`; the agent and MCP get only what a model may request.
            app.manage::<Arc<dyn actions::RequestActions>>(Arc::new(app_actions.clone()));
            app.manage(app_actions);
            app.manage(actions::gui::GuiBuilds::default());
            app.manage(mcp::McpServer::default());
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let server = handle.state::<mcp::McpServer>();
                    let actions = handle.state::<Arc<dyn actions::RequestActions>>().inner().clone();
                    let state = handle.state::<Arc<AppState>>();
                    if let Err(err) = mcp::start_if_enabled(&server, actions, &state, mcp::token).await {
                        log::error!("mcp: failed to start at launch: {err}");
                    }
                });
            }

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

            // The docked inspector shrinks the page; verification runs keep it closed.
            #[cfg(debug_assertions)]
            if std::env::var_os("M3D_E2E_PORT").is_none() {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
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
