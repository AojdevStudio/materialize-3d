//! Integration test: verify printer credential loading and initial state.
//! Run with: cargo test --test integration_connect -- --ignored --nocapture

use std::sync::Arc;

#[tokio::test]
#[ignore] // Only run manually — requires real credentials and network
async fn test_credential_loading_and_initial_state() {
    use materialize_3d_lib::printer::BambuCredentials;
    use materialize_3d_lib::state::AppState;

    let creds = BambuCredentials::load_default().expect("credentials should load");
    println!(
        "Loaded credentials for: {} (device: {})",
        creds.printer.name, creds.printer.device_id
    );

    let state = Arc::new(AppState::default());

    // Verify initial state
    let printer_state = state.printer.lock().unwrap();
    assert_eq!(
        format!("{:?}", printer_state.connection_state),
        "Disconnected"
    );
    println!(
        "Initial connection state: {:?}",
        printer_state.connection_state
    );
    println!(
        "Printer: {} / Device: {}",
        creds.printer.name, creds.printer.device_id
    );
    println!("Host: {:?}", creds.printer.host);
    println!(
        "Access code present: {}",
        !creds.printer.access_code.is_empty()
    );
    println!("✓ Credential loading and initial state verified");
}
