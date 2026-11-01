//! Tauri commands for the chat UI. API keys live in the OS keyring under
//! `api_key:<provider>` and are never logged; the chosen model is the
//! `agent.model` setting, stored as `provider:model`. A provider's server
//! address, when the person saved one, is the `agent.base_url:<provider>`
//! setting, stored exactly as typed.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::protocol::{AgentErrorKind, AgentEvent, AgentStatus, HistoryEntry, Provider};
use super::store;
use super::tools::TurnScope;
use super::turn::{self, ModelChoice, TurnEnd};
use crate::actions::RequestActions;
use crate::credentials;
use crate::database;
use crate::state::AppState;

const MODEL_SETTING: &str = "agent.model";

/// The models offered for a provider; the first is the default. The list holds
/// only current frontier models, because the agent relies on their 3D, CAD, and
/// computer use ability. Add a newer model at the top and drop the one it replaces.
pub fn models(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::Anthropic => &["claude-opus-5-5", "claude-fable-5-1"],
        Provider::Openai => &["gpt-6-astra", "gpt-6.1-sol"],
    }
}

/// The model used for a provider until the person picks another.
pub fn default_model(provider: Provider) -> &'static str {
    models(provider)[0]
}

/// Resolves a requested model: empty means the default. A model the provider
/// does not offer is refused, unless the provider has a custom server address,
/// which may name its models differently.
pub(super) fn offered_model(provider: Provider, model: &str, custom_server: bool) -> Result<String, String> {
    match model.trim() {
        "" => Ok(default_model(provider).to_owned()),
        model if custom_server || models(provider).contains(&model) => Ok(model.to_owned()),
        model => Err(format!("{model} is not an offered {} model", provider_id(provider))),
    }
}

/// A provider server address the person saved: an `https://` URL, or an
/// `http://` URL to a loopback or private address, such as a gateway on the
/// tailnet. It is kept exactly as typed; nothing appends or guesses a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseUrl(String);

impl BaseUrl {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        let url = url::Url::parse(text).map_err(|_| format!("{text} is not a full address. Use one like https://gateway.example/v1"))?;
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
            return Err("the server address cannot hold a user name, password, query, or fragment".into());
        }
        let private_host = match url.host() {
            Some(url::Host::Domain(domain)) => domain == "localhost",
            Some(url::Host::Ipv4(ip)) => is_private(IpAddr::V4(ip)),
            Some(url::Host::Ipv6(ip)) => is_private(IpAddr::V6(ip)),
            None => false,
        };
        match url.scheme() {
            "https" => Ok(Self(text.to_owned())),
            "http" if private_host => Ok(Self(text.to_owned())),
            _ => Err("the server address must start with https://, or http:// for a loopback or private address".into()),
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Loopback, private network, or the shared range Tailscale uses (100.64.0.0/10).
fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private() || (ip.octets()[0] == 100 && ip.octets()[1] & 0xc0 == 64),
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    }
}

fn provider_id(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "anthropic",
        Provider::Openai => "openai",
    }
}

fn key_name(provider: Provider) -> String {
    format!("api_key:{}", provider_id(provider))
}

fn base_url_name(provider: Provider) -> String {
    format!("agent.base_url:{}", provider_id(provider))
}

/// The server address saved for a provider, as stored. A stored value is
/// parsed again where it is used, so a bad one never sends a key anywhere.
pub(super) fn base_url_setting(conn: &Connection, provider: Provider) -> store::Result<Option<String>> {
    database::get_setting(conn, &base_url_name(provider)).map_err(store::StoreError::Settings)
}

/// Reads `agent.model`; a missing or unreadable value means the default. A
/// stored model the provider no longer offers reads as that provider's default,
/// so a retired model never stays selected, unless the provider has a custom
/// server address. The setting is not rewritten.
pub(super) fn model_setting(conn: &Connection) -> store::Result<(Provider, String)> {
    let stored = database::get_setting(conn, MODEL_SETTING).map_err(store::StoreError::Settings)?;
    let parsed = stored.as_deref().and_then(|value| {
        let (provider, model) = value.split_once(':')?;
        let provider = [Provider::Anthropic, Provider::Openai].into_iter().find(|p| provider_id(*p) == provider)?;
        Some((provider, model))
    });
    let Some((provider, model)) = parsed else {
        return Ok((Provider::Anthropic, default_model(Provider::Anthropic).to_owned()));
    };
    let custom_server = base_url_setting(conn, provider)?.is_some();
    Ok((provider, offered_model(provider, model, custom_server).unwrap_or_else(|_| default_model(provider).to_owned())))
}

/// Stores the model for `provider`; see [`offered_model`].
pub(super) fn save_model(conn: &Connection, provider: Provider, model: &str) -> Result<(), String> {
    let custom_server = base_url_setting(conn, provider).map_err(|e| e.to_string())?.is_some();
    let model = offered_model(provider, model, custom_server)?;
    database::upsert_setting(conn, MODEL_SETTING, &format!("{}:{model}", provider_id(provider)))
}

/// Stores a provider's server address. Empty clears it, and a provider that
/// is in use returns to its default model, since a model the gateway named may
/// not exist on the provider's own server.
pub(super) fn save_base_url(conn: &Connection, provider: Provider, base_url: &str) -> Result<(), String> {
    if base_url.trim().is_empty() {
        database::delete_setting(conn, &base_url_name(provider))?;
        let (active, _) = model_setting(conn).map_err(|e| e.to_string())?;
        if active == provider {
            save_model(conn, provider, "")?;
        }
        return Ok(());
    }
    let base_url = BaseUrl::parse(base_url)?;
    database::upsert_setting(conn, &base_url_name(provider), base_url.as_str())
}

/// Picks the turn's model, refusing before any network call when no key is stored.
/// A saved server address that no longer parses refuses the turn as well.
pub fn choose_model(
    provider: Provider,
    model: String,
    api_key: Option<String>,
    base_url: Option<&str>,
) -> Result<ModelChoice, TurnEnd> {
    let base_url = base_url.map(BaseUrl::parse).transpose().map_err(|err| {
        TurnEnd::failed(
            AgentErrorKind::Provider,
            format!("The saved {} server address is not allowed: {err}. Change it in the agent settings.", provider_id(provider)),
        )
    })?;
    match api_key.filter(|key| !key.trim().is_empty()) {
        Some(api_key) => Ok(ModelChoice::Provider { provider, model, api_key, base_url }),
        None => Err(TurnEnd::failed(
            AgentErrorKind::MissingApiKey,
            format!("No {} API key is saved. Add one in the agent settings.", provider_id(provider)),
        )),
    }
}

async fn status(state: &AppState) -> Result<AgentStatus, String> {
    let (provider, model, base_url) = store::with_conn(state, |conn| {
        let (provider, model) = model_setting(conn)?;
        Ok((provider, model, base_url_setting(conn, provider)?))
    })
    .map_err(|e| e.to_string())?;
    let has_api_key = credentials::has_credential(&key_name(provider)).await?;
    Ok(AgentStatus { provider, model, models: models(provider), has_api_key, base_url })
}

/// Cancel handles for running turns, keyed by the UI's turn id.
#[derive(Default)]
pub struct AgentTurns(Mutex<HashMap<String, RunningTurn>>);

struct RunningTurn {
    conversation_id: String,
    cancel: CancellationToken,
}

impl AgentTurns {
    /// Registers a turn, refusing a second concurrent turn in the same
    /// conversation: both would append to one history in an undefined order.
    fn begin(&self, conversation_id: &str, turn_id: &str) -> Result<CancellationToken, String> {
        let mut running = self.0.lock().map_err(|e| e.to_string())?;
        if running.contains_key(turn_id) {
            return Err(format!("turn {turn_id} is already running"));
        }
        if running.values().any(|turn| turn.conversation_id == conversation_id) {
            return Err("a reply is still running in this conversation; stop it or wait for it to finish".into());
        }
        let cancel = CancellationToken::new();
        running.insert(turn_id.to_owned(), RunningTurn { conversation_id: conversation_id.to_owned(), cancel: cancel.clone() });
        Ok(cancel)
    }

    fn end(&self, turn_id: &str) {
        if let Ok(mut running) = self.0.lock() {
            running.remove(turn_id);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationHistory {
    pub conversation_id: String,
    pub entries: Vec<HistoryEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewConversation {
    pub conversation_id: String,
}

#[tauri::command]
pub async fn agent_status(state: State<'_, Arc<AppState>>) -> Result<AgentStatus, String> {
    status(&state).await
}

#[tauri::command]
pub async fn agent_set_api_key(
    state: State<'_, Arc<AppState>>,
    provider: Provider,
    api_key: String,
) -> Result<AgentStatus, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("the API key is empty".into());
    }
    credentials::store_credential(&key_name(provider), api_key).await?;
    status(&state).await
}

#[tauri::command]
pub async fn agent_clear_api_key(state: State<'_, Arc<AppState>>, provider: Provider) -> Result<AgentStatus, String> {
    credentials::delete_credential(&key_name(provider)).await?;
    status(&state).await
}

/// An empty `model` selects the provider's default; a model the provider does
/// not offer is refused and nothing is stored, unless the provider has a
/// custom server address.
#[tauri::command]
pub async fn agent_set_model(
    state: State<'_, Arc<AppState>>,
    provider: Provider,
    model: String,
) -> Result<AgentStatus, String> {
    store::with_conn(&state, |conn| Ok(save_model(conn, provider, &model))).map_err(|e| e.to_string())??;
    status(&state).await
}

/// An empty `base_url` clears the address, so the provider's own server is used.
#[tauri::command]
pub async fn agent_set_base_url(
    state: State<'_, Arc<AppState>>,
    provider: Provider,
    base_url: String,
) -> Result<AgentStatus, String> {
    store::with_conn(&state, |conn| Ok(save_base_url(conn, provider, &base_url))).map_err(|e| e.to_string())??;
    status(&state).await
}

#[tauri::command]
pub fn agent_history(state: State<'_, Arc<AppState>>) -> Result<ConversationHistory, String> {
    store::with_conn(&state, |conn| {
        let conversation_id = store::current_conversation(conn)?;
        let entries = store::history(conn, &conversation_id)?;
        Ok(ConversationHistory { conversation_id, entries })
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_new_conversation(state: State<'_, Arc<AppState>>) -> Result<NewConversation, String> {
    store::with_conn(&state, |conn| store::new_conversation(conn))
        .map(|conversation_id| NewConversation { conversation_id })
        .map_err(|e| e.to_string())
}

/// Resolves when the turn has ended; its events, including the terminal one,
/// arrive on `on_event`.
#[tauri::command]
pub async fn agent_send(
    state: State<'_, Arc<AppState>>,
    actions: State<'_, Arc<dyn RequestActions>>,
    turns: State<'_, AgentTurns>,
    conversation_id: String,
    turn_id: String,
    text: String,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    let cancel = turns.begin(&conversation_id, &turn_id)?;

    let setting = store::with_conn(&state, |conn| {
        let (provider, model) = model_setting(conn)?;
        Ok((provider, model, base_url_setting(conn, provider)?))
    });
    let model = match setting {
        Ok((provider, model, base_url)) => match credentials::get_credential(&key_name(provider)).await {
            Ok(api_key) => choose_model(provider, model, api_key, base_url.as_deref()),
            Err(err) => Err(TurnEnd::failed(AgentErrorKind::Internal, format!("reading the API key failed: {err}"))),
        },
        Err(err) => Err(TurnEnd::from(err)),
    };
    let scope = Arc::new(TurnScope {
        conversation_id,
        turn_id: turn_id.clone(),
        state: state.inner().clone(),
        actions: actions.inner().clone(),
        // A closed window drops the channel; the turn still runs to its end and is stored.
        emit: Arc::new(move |event| {
            let _ = on_event.send(event);
        }),
        cancel,
        blocking: TaskTracker::new(),
    });
    turn::run_turn(scope, text, model).await;

    turns.end(&turn_id);
    Ok(())
}

#[tauri::command]
pub fn agent_cancel(turns: State<'_, AgentTurns>, turn_id: String) -> Result<bool, String> {
    let running = turns.0.lock().map_err(|e| e.to_string())?;
    Ok(running.get(&turn_id).map(|turn| turn.cancel.cancel()).is_some())
}

#[cfg(test)]
mod turn_guard_tests {
    use super::AgentTurns;

    #[test]
    fn one_running_turn_per_conversation() {
        let turns = AgentTurns::default();
        turns.begin("c1", "t1").expect("first turn");
        assert!(turns.begin("c1", "t2").is_err(), "second concurrent turn in the same conversation");
        assert!(turns.begin("c2", "t3").is_ok(), "another conversation may run");
        turns.end("t1");
        assert!(turns.begin("c1", "t4").is_ok(), "the conversation is free after its turn ends");
    }
}
