//! Materialize 3D on iPhone and iPad. The paired computer runs every chat. This app keeps the pairing in the Keychain and
//! forwards the window's reads and sends to the computer's service with the device token, so the token never reaches the
//! window.

mod drafts;
mod events;
mod paired;
mod remote;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .manage(paired::Paired::default())
        .manage(remote::ModelReads::default())
        .manage(events::Watcher::default())
        .setup(|app| {
            app.manage(drafts::Drafts::new(app.path().app_data_dir()?.join("drafts")));
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(remote::SCHEME, remote::serve)
        .invoke_handler(tauri::generate_handler![
            paired::paired_computer,
            paired::pair,
            paired::forget,
            remote::stop_model_reads,
            drafts::draft_load,
            drafts::draft_save,
            events::link_watch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Materialize 3D");
}
