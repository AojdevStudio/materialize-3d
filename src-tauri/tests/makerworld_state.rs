use materialize_3d_lib::state::{AppState, MakerWorldPageKind, ModelImportStatus};

#[test]
fn workspace_snapshot_defaults_to_makerworld_home_surface() {
    let state = AppState::default();
    let snapshot = state.snapshot().expect("snapshot should succeed");

    assert_eq!(snapshot.workspace.makerworld.current_url, "https://makerworld.com/en");
    assert_eq!(snapshot.workspace.makerworld.page_kind, MakerWorldPageKind::Home);
    assert_eq!(snapshot.workspace.makerworld.import_status, ModelImportStatus::Idle);
    assert!(snapshot.workspace.makerworld.detected_model.is_none());
    assert!(snapshot.workspace.makerworld.imported_files.is_empty());
}

#[test]
fn makerworld_page_kind_round_trips_through_json() {
    let json = serde_json::to_string(&MakerWorldPageKind::Model).expect("serialize");
    let round_trip: MakerWorldPageKind = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(round_trip, MakerWorldPageKind::Model);
}
