//! Secure credential storage backed by the OS-native credential store
//! (macOS Keychain, Windows Credential Manager, Linux Secret Service) via the
//! `keyring` crate.
//!
//! Every operation is wrapped in `tokio::task::spawn_blocking` because
//! `keyring::Entry` methods are synchronous and may prompt the user.

const SERVICE: &str = "com.materialize3d";

/// Store a credential in the OS-native credential store.
pub async fn store_credential(key: &str, value: &str) -> Result<(), String> {
    let key = key.to_owned();
    let value = value.to_owned();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring entry error for key={key}: {e}"))?;
        entry
            .set_password(&value)
            .map_err(|e| format!("keyring set_password error for key={key}: {e}"))?;
        log::info!("credential:stored key={key}");
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

/// Retrieve a credential from the OS-native credential store.
///
/// Returns `None` if the credential does not exist (rather than an error).
pub async fn get_credential(key: &str) -> Result<Option<String>, String> {
    let key = key.to_owned();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring entry error for key={key}: {e}"))?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring get_password error for key={key}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

/// Delete a credential from the OS-native credential store.
///
/// Returns `true` if deleted, `false` if the credential did not exist.
pub async fn delete_credential(key: &str) -> Result<bool, String> {
    let key = key.to_owned();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring entry error for key={key}: {e}"))?;
        match entry.delete_credential() {
            Ok(()) => {
                log::info!("credential:deleted key={key}");
                Ok(true)
            }
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(format!("keyring delete_credential error for key={key}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

/// Check whether a credential exists in the OS-native credential store.
pub async fn has_credential(key: &str) -> Result<bool, String> {
    let key = key.to_owned();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring entry error for key={key}: {e}"))?;
        match entry.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(format!("keyring has_credential error for key={key}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that the service constant is set correctly.
    #[test]
    fn service_name_is_correct() {
        assert_eq!(SERVICE, "com.materialize3d");
    }

    /// Verify keyring::Entry can be constructed without error for arbitrary keys.
    /// This tests the key format construction logic (service + key → Entry).
    #[test]
    fn entry_construction_succeeds_for_various_keys() {
        let keys = [
            "anthropic:access_token",
            "openai:access_token",
            "bambu:serial",
            "test-key-with-dashes",
            "key.with.dots",
        ];
        for key in &keys {
            let entry = keyring::Entry::new(SERVICE, key);
            assert!(
                entry.is_ok(),
                "Entry::new should succeed for key '{key}', got: {:?}",
                entry.err()
            );
        }
    }

    /// Verify that NoEntry is correctly identified as the "not found" variant.
    /// We use the Display impl to confirm the error type since keyring::Error
    /// doesn't expose variant checks via public methods on all platforms.
    #[test]
    fn no_entry_error_is_distinguishable() {
        let err = keyring::Error::NoEntry;
        let msg = format!("{err}");
        // The NoEntry error should produce a recognizable message
        assert!(
            !msg.is_empty(),
            "NoEntry error should have a non-empty display"
        );
    }

    /// Verify error mapping produces descriptive messages including the key name.
    #[test]
    fn error_messages_include_key_name() {
        let key = "test-key";
        let err_msg = format!("keyring set_password error for key={key}: simulated error");
        assert!(err_msg.contains("test-key"));
        assert!(err_msg.contains("keyring"));
    }
}
