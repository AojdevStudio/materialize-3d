//! The app's items in the OS credential store: the Keychain on macOS, the Secret Service on Linux.

/// Not the bundle id. Renaming either loses every saved sign-in.
const SERVICE: &str = "com.materialize3d";
/// Keychain items the sidecar may touch. Any other item, such as a printer's access code, is out of its reach.
const KEYCHAIN_PREFIX: &str = "inference.";

/// The Keychain item for an inference login. The account is a provider id, never a path or another item's name.
pub fn keychain_item(account: &str) -> Result<String, String> {
    let valid = !account.is_empty()
        && account.len() <= 64
        && account.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
    if valid {
        Ok(format!("{KEYCHAIN_PREFIX}{account}"))
    } else {
        Err(format!("{account:?} is not a provider account"))
    }
}

/// keyring's calls block and may prompt the person, so each runs on a blocking thread.
async fn with_entry<T: Send + 'static>(
    key: &str,
    work: impl FnOnce(&str, keyring::Entry) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let key = key.to_owned();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SERVICE, &key).map_err(|e| format!("keyring entry error for key={key}: {e}"))?;
        work(&key, entry)
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

pub async fn store_credential(key: &str, value: &str) -> Result<(), String> {
    let value = value.to_owned();
    with_entry(key, move |key, entry| {
        entry
            .set_password(&value)
            .map_err(|e| format!("keyring set_password error for key={key}: {e}"))?;
        log::info!("credential:stored key={key}");
        Ok(())
    })
    .await
}

pub async fn get_credential(key: &str) -> Result<Option<String>, String> {
    with_entry(key, |key, entry| match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get_password error for key={key}: {e}")),
    })
    .await
}

pub async fn delete_credential(key: &str) -> Result<(), String> {
    with_entry(key, |key, entry| match entry.delete_credential() {
        Ok(()) => {
            log::info!("credential:deleted key={key}");
            Ok(())
        }
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete_credential error for key={key}: {e}")),
    })
    .await
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    /// Each item's secret in the test store, by service and item name, for the whole test run.
    static SECRETS: LazyLock<Mutex<HashMap<(String, String), Vec<u8>>>> = LazyLock::new(Mutex::default);

    /// An item in the test store. Every entry for the same service and item name reads the same secret, as in the real
    /// store.
    struct TestItem {
        key: (String, String),
    }

    impl TestItem {
        /// An item whose name ends in `fails.call` fails every call, the way a locked Keychain does.
        fn reach(&self) -> keyring::Result<std::sync::MutexGuard<'static, HashMap<(String, String), Vec<u8>>>> {
            if self.key.1.ends_with("fails.call") {
                return Err(keyring::Error::PlatformFailure("locked".into()));
            }
            Ok(SECRETS.lock().expect("no test panics while it holds the test store"))
        }
    }

    impl keyring::credential::CredentialApi for TestItem {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            self.reach()?.insert(self.key.clone(), secret.to_vec());
            Ok(())
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            self.reach()?.get(&self.key).cloned().ok_or(keyring::Error::NoEntry)
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            self.reach()?.remove(&self.key).map(drop).ok_or(keyring::Error::NoEntry)
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    /// An item whose name ends in `fails.entry` cannot be made.
    struct TestStore;

    impl keyring::credential::CredentialBuilderApi for TestStore {
        fn build(&self, _target: Option<&str>, service: &str, user: &str) -> keyring::Result<Box<keyring::credential::Credential>> {
            if user.ends_with("fails.entry") {
                return Err(keyring::Error::Invalid("user".to_owned(), "refused by the test store".to_owned()));
            }
            Ok(Box::new(TestItem { key: (service.to_owned(), user.to_owned()) }))
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    /// Every entry made from here on lives in the test store, in memory. Nothing reaches the machine's own store.
    pub(crate) fn use_test_store() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| keyring::set_default_credential_builder(Box::new(TestStore)));
    }

    #[tokio::test]
    async fn a_stored_secret_reads_back_until_it_is_deleted() {
        use_test_store();
        let item = "inference.round-trip";
        assert_eq!(get_credential(item).await, Ok(None));
        assert_eq!(store_credential(item, "secret").await, Ok(()));
        assert_eq!(get_credential(item).await, Ok(Some("secret".to_owned())));
        assert_eq!(delete_credential(item).await, Ok(()));
        assert_eq!(get_credential(item).await, Ok(None));
        assert_eq!(delete_credential(item).await, Ok(()));
    }

    /// Copies already installed saved their sign-ins under this service name, so a new build must read them there.
    #[tokio::test]
    async fn a_sign_in_an_installed_copy_saved_still_reads_back() {
        use_test_store();
        let saved = ("com.materialize3d".to_owned(), "inference.installed".to_owned());
        SECRETS.lock().expect("no test panics while it holds the test store").insert(saved, b"secret".to_vec());
        assert_eq!(get_credential("inference.installed").await, Ok(Some("secret".to_owned())));
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
    fn each_provider_the_sidecar_signs_in_to_has_its_own_item() {
        let contract = crate::sidecar::tests::contract();
        assert_eq!(KEYCHAIN_PREFIX, contract.keychain_prefix);
        for provider in contract.providers {
            assert_eq!(keychain_item(&provider), Ok(format!("{KEYCHAIN_PREFIX}{provider}")));
        }
    }

    #[test]
    fn the_sidecar_reaches_only_inference_items_in_the_keychain() {
        assert_eq!(keychain_item("anthropic").as_deref(), Ok("inference.anthropic"));
        assert_eq!(keychain_item("openai-codex").as_deref(), Ok("inference.openai-codex"));
        for bad in ["", "printer/access", "../printer", "Anthropic", "a b", &"x".repeat(65)] {
            assert!(keychain_item(bad).is_err(), "{bad:?} must be refused");
        }
    }

    /// The build's own store, from the platform feature in Cargo.toml. Without one, keyring falls back to its mock
    /// store, which forgets every sign-in.
    #[test]
    fn the_platform_store_keeps_sign_ins_until_they_are_deleted() {
        use keyring::credential::CredentialPersistence;
        assert!(matches!(
            keyring::default::default_credential_builder().persistence(),
            CredentialPersistence::UntilDelete
        ));
    }
}
