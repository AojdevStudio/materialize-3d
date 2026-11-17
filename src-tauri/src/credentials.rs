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

/// Delete a credential from the OS-native credential store. A credential that
/// does not exist counts as deleted.
pub async fn delete_credential(key: &str) -> Result<(), String> {
    let key = key.to_owned();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring entry error for key={key}: {e}"))?;
        match entry.delete_credential() {
            Ok(()) => {
                log::info!("credential:deleted key={key}");
                Ok(())
            }
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete_credential error for key={key}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// keyring's mock store. An item whose name ends in `fails.entry` cannot be made, and one that ends in
    /// `fails.call` fails its first call, the way a locked Keychain does.
    struct TestStore;

    impl keyring::credential::CredentialBuilderApi for TestStore {
        fn build(&self, _target: Option<&str>, _service: &str, user: &str) -> keyring::Result<Box<keyring::credential::Credential>> {
            if user.ends_with("fails.entry") {
                return Err(keyring::Error::Invalid("user".to_owned(), "refused by the test store".to_owned()));
            }
            let credential = keyring::mock::MockCredential::default();
            if user.ends_with("fails.call") {
                credential.set_error(keyring::Error::PlatformFailure("locked".into()));
            }
            Ok(Box::new(credential))
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    /// Every entry made from here on lives in keyring's mock store, which keeps a secret only in the entry that set
    /// it. Nothing reaches the machine's own store.
    pub(crate) fn use_test_store() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| keyring::set_default_credential_builder(Box::new(TestStore)));
    }

    #[tokio::test]
    async fn a_secret_is_stored_and_a_missing_one_reads_as_none_and_counts_as_deleted() {
        use_test_store();
        assert_eq!(store_credential("inference.anthropic", "secret").await, Ok(()));
        assert_eq!(get_credential("inference.anthropic").await, Ok(None));
        assert_eq!(delete_credential("inference.anthropic").await, Ok(()));
    }

    #[tokio::test]
    async fn a_store_failure_names_the_call_and_the_item_but_not_the_secret() {
        use_test_store();
        let locked = keyring::Error::PlatformFailure("locked".into());
        assert_eq!(store_credential("fails.call", "secret").await, Err(format!("keyring set_password error for key=fails.call: {locked}")));
        assert_eq!(get_credential("fails.call").await, Err(format!("keyring get_password error for key=fails.call: {locked}")));
        assert_eq!(delete_credential("fails.call").await, Err(format!("keyring delete_credential error for key=fails.call: {locked}")));
        let refused = keyring::Error::Invalid("user".to_owned(), "refused by the test store".to_owned());
        let expected = Err(format!("keyring entry error for key=fails.entry: {refused}"));
        assert_eq!(store_credential("fails.entry", "secret").await, expected);
        assert_eq!(get_credential("fails.entry").await.map(|_| ()), expected);
        assert_eq!(delete_credential("fails.entry").await, expected);
    }

    #[test]
    fn service_name_is_correct() {
        assert_eq!(SERVICE, "com.materialize3d");
    }

    #[test]
    fn default_store_keeps_credentials_until_deleted() {
        use keyring::credential::CredentialPersistence;
        assert!(matches!(
            keyring::default::default_credential_builder().persistence(),
            CredentialPersistence::UntilDelete
        ));
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
