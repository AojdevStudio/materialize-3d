//! The one computer this device is paired with. The Keychain holds it, so a relaunch needs no new pairing.

use std::sync::RwLock;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use url::Url;

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

/// What the window may know of the paired computer.
#[derive(Serialize)]
pub struct Computer {
    name: String,
    origin: String,
}

impl From<&Pairing> for Computer {
    fn from(pairing: &Pairing) -> Self {
        Computer { name: pairing.name.clone(), origin: pairing.origin.to_string() }
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
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// The pairing in memory. `paired_computer`, which the window calls first, reads it from the Keychain.
#[derive(Default)]
pub struct Paired(RwLock<Option<Pairing>>);

impl Paired {
    pub fn current(&self) -> Option<Pairing> {
        self.0.read().expect("pairing lock").clone()
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

/// Reads the saved pairing. A Keychain that refuses, or a damaged item, reaches the window, which offers to pair again.
#[tauri::command]
pub fn paired_computer(paired: tauri::State<'_, Paired>) -> Result<Option<Computer>, Error> {
    let saved: Option<Pairing> = match entry()?.get_password() {
        Ok(json) => Some(serde_json::from_str(&json)?),
        Err(keyring::Error::NoEntry) => None,
        Err(err) => return Err(err.into()),
    };
    let computer = saved.as_ref().map(Computer::from);
    *paired.0.write().expect("pairing lock") = saved;
    Ok(computer)
}

/// Redeems the code in a scanned link with the computer it names, then saves the grant.
#[tauri::command]
pub async fn pair(link: String, device: String, paired: tauri::State<'_, Paired>) -> Result<Computer, Error> {
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
    let mut current = paired.0.write().expect("pairing lock");
    entry()?.set_password(&serde_json::to_string(&pairing)?)?;
    *current = Some(pairing);
    Ok(computer)
}

#[tauri::command]
pub fn forget(paired: tauri::State<'_, Paired>) -> Result<(), Error> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(err) => return Err(err.into()),
    }
    *paired.0.write().expect("pairing lock") = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
