fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["paired_computer", "pair", "forget"])))
        .expect("failed to run tauri-build");
}
