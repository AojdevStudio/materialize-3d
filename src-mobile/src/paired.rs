//! The one computer this device is paired with. The Keychain holds it, so a relaunch needs no new pairing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::drafts::Drafts;
use crate::events::Watcher;

/// Not the bundle id. Renaming either loses the pairing.
const SERVICE: &str = "com.materialize3d.mobile";
const ACCOUNT: &str = "paired-computer";

/// What the Keychain holds. The token is the computer's grant to this device and never leaves Rust.
#[derive(Clone, Serialize, Deserialize)]
pub struct Pairing {
    pub origin: Url,
    pub name: String,
    pub token: String,
}

impl Pairing {
    pub fn id(&self) -> PairingId {
        PairingId::of(&self.token)
    }
}

/// Names one pairing: the first 16 characters of the lowercase hex SHA-256 of its token. Each pairing gets a new token,
/// so a new pairing, even with the same computer, gets a new id, and the token cannot be read back from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct PairingId(String);

impl PairingId {
    pub fn of(token: &str) -> Self {
        PairingId(Sha256::digest(token.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What the window may know of the paired computer.
#[derive(Serialize)]
pub struct Computer {
    id: PairingId,
    name: String,
    origin: String,
}

impl From<&Pairing> for Computer {
    fn from(pairing: &Pairing) -> Self {
        Computer { id: pairing.id(), name: pairing.name.clone(), origin: pairing.origin.to_string() }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("This is not a Materialize pairing code.")]
    NotAPairingCode,
    #[error("The computer did not answer. Check that Tailscale is on. {0}")]
    Unreachable(#[from] reqwest::Error),
    #[error("This code is wrong, expired, or already used. Show a new code on the computer and scan again.")]
    CodeRefused,
    #[error("The computer refused to pair ({0}).")]
    Refused(u16),
    #[error("The Keychain refused the pairing. {0}")]
    Keychain(#[from] keyring::Error),
    #[error("The saved pairing is damaged. Pair again. {0}")]
    Damaged(#[from] serde_json::Error),
    #[error("A newer pairing or a Forget took this pairing's place, so it changed nothing.")]
    Superseded,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// The pairing in memory, and its generation: how many pairings landed and Forgets succeeded. `paired_computer`, which
/// the window calls first, reads the pairing from the Keychain.
#[derive(Default)]
pub struct Paired(RwLock<Option<Pairing>>, AtomicU64);

impl Paired {
    pub fn current(&self) -> Option<Pairing> {
        self.0.read().expect("pairing lock").clone()
    }

    /// The generation a pairing attempt starts from.
    fn generation(&self) -> u64 {
        self.1.load(Ordering::SeqCst)
    }

    /// Lands a pairing that started at `generation`. Under the pairing lock, `save` keeps it, and it becomes the current
    /// pairing. A pairing that landed, or a Forget that succeeded, since the attempt started supersedes it, and then
    /// nothing changes, so a pairing that finishes late never sweeps away the drafts of the one that took its place. An
    /// attempt that was refused supersedes nothing, so a second scan of a spent code leaves the first to land.
    fn land(&self, generation: u64, pairing: Pairing, save: impl FnOnce(&Pairing) -> Result<(), Error>) -> Result<(), Error> {
        let mut current = self.0.write().expect("pairing lock");
        if self.generation() != generation {
            return Err(Error::Superseded);
        }
        save(&pairing)?;
        self.1.fetch_add(1, Ordering::SeqCst);
        *current = Some(pairing);
        Ok(())
    }

    /// Forgets the pairing once `delete` takes it out of the Keychain, and answers it. A `delete` that fails changes
    /// nothing. One that succeeds supersedes every pairing still on its way.
    fn forget(&self, delete: impl FnOnce() -> Result<(), Error>) -> Result<Option<Pairing>, Error> {
        let mut current = self.0.write().expect("pairing lock");
        delete()?;
        self.1.fetch_add(1, Ordering::SeqCst);
        Ok(current.take())
    }
}

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT)
}

/// The reply to a redeemed pairing code, as `POST /api/v1/pair` answers it.
#[derive(Deserialize)]
struct Grant {
    token: String,
    computer: Identity,
}

#[derive(Deserialize)]
struct Identity {
    name: String,
}

/// The computer's origin and the code from the link in its QR image, `https://<host>.<tailnet>.ts.net[:port]/pair?code=<code>`
/// and nothing more. Only a Tailscale Serve address on the person's tailnet can pair this device.
fn parse_link(link: &str) -> Result<(Url, String), Error> {
    let link = Url::parse(link).map_err(|_| Error::NotAPairingCode)?;
    let serve = link.scheme() == "https"
        && link.host_str().is_some_and(|host| host.ends_with(".ts.net"))
        && link.username().is_empty()
        && link.password().is_none()
        && link.path() == "/pair"
        && link.fragment().is_none();
    let mut query = link.query_pairs();
    let code = match (query.next(), query.next()) {
        (Some((key, code)), None) if key == "code" && !code.is_empty() && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') => code.into_owned(),
        _ => return Err(Error::NotAPairingCode),
    };
    if !serve {
        return Err(Error::NotAPairingCode);
    }
    let origin = Url::parse(&link.origin().ascii_serialization()).map_err(|_| Error::NotAPairingCode)?;
    Ok((origin, code))
}

/// Reads the saved pairing, and sweeps away the drafts of every other. A Keychain that refuses, or a damaged item,
/// reaches the window, which offers to pair again.
#[tauri::command]
pub fn paired_computer(paired: tauri::State<'_, Paired>, drafts: tauri::State<'_, Drafts>) -> Result<Option<Computer>, Error> {
    let saved: Option<Pairing> = match entry()?.get_password() {
        Ok(json) => Some(serde_json::from_str(&json)?),
        Err(keyring::Error::NoEntry) => None,
        Err(err) => return Err(err.into()),
    };
    let computer = saved.as_ref().map(Computer::from);
    drafts.sweep(saved.as_ref().map(Pairing::id).as_ref());
    *paired.0.write().expect("pairing lock") = saved;
    Ok(computer)
}

/// Redeems the code in a scanned link with the computer it names, saves the grant, and sweeps away the drafts of every
/// other pairing.
#[tauri::command]
pub async fn pair(link: String, device: String, paired: tauri::State<'_, Paired>, drafts: tauri::State<'_, Drafts>) -> Result<Computer, Error> {
    let generation = paired.generation();
    let (origin, code) = parse_link(&link)?;
    let reply = crate::remote::client()
        .post(crate::remote::url(&origin, "/api/v1/pair", None))
        .json(&serde_json::json!({ "code": code, "name": device }))
        .send()
        .await?;
    let grant: Grant = match reply.status() {
        status if status.is_success() => reply.json().await?,
        StatusCode::FORBIDDEN => return Err(Error::CodeRefused),
        status => return Err(Error::Refused(status.as_u16())),
    };
    let pairing = Pairing { origin, name: grant.computer.name, token: grant.token };
    let computer = Computer::from(&pairing);
    // The Keychain and memory change together, so two scans that finish out of order leave one pairing in both.
    paired.land(generation, pairing, |pairing| {
        entry()?.set_password(&serde_json::to_string(pairing)?)?;
        drafts.sweep(Some(&pairing.id()));
        Ok(())
    })?;
    Ok(computer)
}

/// Forgets the computer: its credential, its link, and every draft written for its chats.
#[tauri::command]
pub fn forget(paired: tauri::State<'_, Paired>, drafts: tauri::State<'_, Drafts>, watcher: tauri::State<'_, Watcher>) -> Result<(), Error> {
    // The credential goes first, so an error leaves the pairing and its drafts as they were, and the window goes on with them.
    let forgotten = paired.forget(|| match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.into()),
    })?;
    watcher.stop();
    if let Some(forgotten) = forgotten {
        drafts.remove(&forgotten.id());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing(token: &str) -> Pairing {
        Pairing { origin: Url::parse("https://studio.tail1234.ts.net:47380/").expect("an origin"), name: "Studio Mac".into(), token: token.into() }
    }

    fn token(paired: &Paired) -> Option<String> {
        paired.current().map(|pairing| pairing.token)
    }

    #[test]
    fn a_pairing_that_finishes_after_a_newer_one_landed_changes_nothing() {
        let paired = Paired::default();
        let first = paired.generation();
        let second = paired.generation();
        paired.land(second, pairing("token-b"), |_| Ok(())).expect("the newer pairing lands");
        let mut saved = false;
        let late = paired.land(first, pairing("token-a"), |_| {
            saved = true;
            Ok(())
        });
        assert!(matches!(late, Err(Error::Superseded)));
        assert!(!saved, "the late pairing reached the Keychain and the drafts");
        assert_eq!(token(&paired), Some("token-b".into()));
    }

    #[test]
    fn a_refused_second_scan_leaves_the_first_pairing_to_land() {
        let paired = Paired::default();
        let first = paired.generation();
        // A second scan of the same code starts, and the computer refuses it, so it never lands.
        let _second = paired.generation();
        paired.land(first, pairing("token-a"), |_| Ok(())).expect("the first pairing lands");
        assert_eq!(token(&paired), Some("token-a".into()));
    }

    #[test]
    fn a_pairing_on_its_way_when_forget_succeeds_changes_nothing() {
        let paired = Paired::default();
        paired.land(paired.generation(), pairing("token-a"), |_| Ok(())).expect("a pairing");
        let on_its_way = paired.generation();
        let forgotten = paired.forget(|| Ok(())).expect("a forget");
        assert_eq!(forgotten.map(|pairing| pairing.token), Some("token-a".into()));
        assert!(matches!(paired.land(on_its_way, pairing("token-b"), |_| Ok(())), Err(Error::Superseded)));
        assert_eq!(token(&paired), None);
    }

    #[test]
    fn a_forget_whose_keychain_delete_fails_changes_nothing() {
        let paired = Paired::default();
        paired.land(paired.generation(), pairing("token-a"), |_| Ok(())).expect("a pairing");
        let on_its_way = paired.generation();
        assert!(paired.forget(|| Err(Error::Superseded)).is_err());
        assert_eq!(token(&paired), Some("token-a".into()));
        // Nothing was forgotten, so a pairing on its way still lands.
        paired.land(on_its_way, pairing("token-b"), |_| Ok(())).expect("the pairing lands");
    }

    #[test]
    fn the_window_gets_the_pairing_id_and_never_the_token() {
        let pairing = Pairing { origin: Url::parse("https://studio.tail1234.ts.net:47380/").expect("an origin"), name: "Studio Mac".into(), token: "token-a".into() };
        let shown = serde_json::to_value(Computer::from(&pairing)).expect("a computer");
        // The first 16 hex characters of the SHA-256 of "token-a".
        assert_eq!(shown, serde_json::json!({ "id": "a70bf50e531ce1a8", "name": "Studio Mac", "origin": "https://studio.tail1234.ts.net:47380/" }));
        assert_eq!(pairing.id(), Pairing { token: "token-a".into(), ..pairing.clone() }.id());
        assert_ne!(pairing.id(), Pairing { token: "token-b".into(), ..pairing }.id());
    }

    #[test]
    fn a_pairing_link_gives_the_origin_with_its_port_and_the_code() {
        let (origin, code) = parse_link("https://studio.tail1234.ts.net:47380/pair?code=K7Q2").expect("a pairing link");
        assert_eq!(origin.as_str(), "https://studio.tail1234.ts.net:47380/");
        assert_eq!(code, "K7Q2");
    }

    #[test]
    fn a_serve_address_on_443_has_no_port() {
        let (origin, _) = parse_link("https://studio.tail1234.ts.net/pair?code=K7Q2").expect("a pairing link");
        assert_eq!(origin.as_str(), "https://studio.tail1234.ts.net/");
    }

    #[test]
    fn any_other_text_is_not_a_pairing_code() {
        for text in [
            "hello",
            "http://studio.tail1234.ts.net:47380/pair?code=K7Q2",
            "https://studio.example.com:47380/pair?code=K7Q2",
            "https://studio.tail1234.ts.net:47380/other?code=K7Q2",
            "https://studio.tail1234.ts.net:47380/pair",
            "https://studio.tail1234.ts.net:47380/pair?code=",
            "https://studio.tail1234.ts.net:47380/pair?code=K7Q2&code=OTHER",
            "https://studio.tail1234.ts.net:47380/pair?code=K7Q2&next=x",
            "https://studio.tail1234.ts.net:47380/pair?code=K7Q2#x",
            "https://me@studio.tail1234.ts.net:47380/pair?code=K7Q2",
            "https://studio.tail1234.ts.net:47380/pair?code=K7%2FQ2",
        ] {
            assert!(matches!(parse_link(text), Err(Error::NotAPairingCode)), "{text}");
        }
    }
}
