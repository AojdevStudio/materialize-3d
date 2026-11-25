fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["paired_computer", "pair", "forget", "stop_model_reads"])))
        .expect("failed to run tauri-build");
}
