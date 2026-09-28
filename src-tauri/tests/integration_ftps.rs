//! Integration test: verify FTPS upload to the real P2S printer.
//! Run with: cargo test --test integration_ftps -- --ignored --nocapture
//!
//! Requires:
//!   - P2S at 192.0.2.136 powered on with Developer Mode enabled
//!   - Valid credentials at ~/.bambu-mcp/credentials.json

#[tokio::test]
#[ignore] // Only run manually — requires real printer on network
async fn test_ftps_upload_to_printer() {
    use materialize_3d_lib::printer::{upload_to_printer, BambuCredentials};

    let creds = BambuCredentials::load_default().expect("credentials should load");
    println!(
        "Testing FTPS upload to {} ({})",
        creds.printer.name, creds.printer.host
    );

    // Create a small test file
    let dir = tempfile::tempdir().expect("create temp dir");
    let test_file = dir.path().join("ftps_test.3mf");
    std::fs::write(&test_file, b"PK\x03\x04test-ftps-upload-content")
        .expect("write test file");

    let result = upload_to_printer(
        &creds.printer.host,
        creds.ftps_password(),
        &test_file,
    )
    .await;

    match &result {
        Ok(()) => println!("FTPS upload succeeded!"),
        Err(e) => println!("FTPS upload failed: {e}"),
    }

    assert!(result.is_ok(), "FTPS upload should succeed: {:?}", result.err());
}

#[tokio::test]
#[ignore]
async fn test_ftps_upload_descriptive_error_on_bad_host() {
    use materialize_3d_lib::printer::upload_to_printer;

    let dir = tempfile::tempdir().expect("create temp dir");
    let test_file = dir.path().join("test.3mf");
    std::fs::write(&test_file, b"test").expect("write test file");

    let result = upload_to_printer("192.0.2.1", "fake-code", &test_file).await;
    assert!(result.is_err());

    let err_msg = result.unwrap_err().to_string();
    println!("Error message: {err_msg}");
    assert!(
        err_msg.contains("FTPS"),
        "error should mention FTPS: {err_msg}"
    );
}
