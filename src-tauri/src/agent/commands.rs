//! Tauri commands for the chat UI. API keys live in the OS keyring under
//! `api_key:<provider>` and are never logged; the chosen model is the
//! `agent.model` setting, stored as `provider:model`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::protocol::{AgentErrorKind, AgentEvent, AgentStatus, HistoryEntry, Provider};
use super::store;
use super::tools::{AgentActions, TurnScope};
use super::turn::{self, ModelChoice, TurnEnd};
use crate::actions::Actions;
use crate::credentials;
use crate::database;
use crate::state::AppState;

const MODEL_SETTING: &str = "agent.model";

/// The model used for a provider until the person picks another.
pub fn default_model(provider: Provider) -> &'static str {
    match provider {
        Provider::Anthropic => "claude-sonnet-5",
        Provider::Openai => "gpt-5.5",
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

/// Reads `agent.model`; a missing or unreadable value means the default.
fn model_setting(conn: &Connection) -> store::Result<(Provider, String)> {
    let stored = database::get_setting(conn, MODEL_SETTING).map_err(store::StoreError::Settings)?;
    let parsed = stored.as_deref().and_then(|value| {
        let (provider, model) = value.split_once(':')?;
        let provider = [Provider::Anthropic, Provider::Openai].into_iter().find(|p| provider_id(*p) == provider)?;
        (!model.trim().is_empty()).then(|| (provider, model.trim().to_owned()))
    });
    Ok(parsed.unwrap_or((Provider::Anthropic, default_model(Provider::Anthropic).to_owned())))
}

/// Picks the turn's model, refusing before any network call when no key is stored.
pub fn choose_model(provider: Provider, model: String, api_key: Option<String>) -> Result<ModelChoice, TurnEnd> {
    match api_key.filter(|key| !key.trim().is_empty()) {
        Some(api_key) => Ok(ModelChoice::Provider { provider, model, api_key }),
        None => Err(TurnEnd::failed(
            AgentErrorKind::MissingApiKey,
            format!("No {} API key is saved. Add one in the agent settings.", provider_id(provider)),
        )),
    }
}

async fn status(state: &AppState) -> Result<AgentStatus, String> {
    let (provider, model) = store::with_conn(state, |conn| model_setting(conn)).map_err(|e| e.to_string())?;
    let has_api_key = credentials::has_credential(&key_name(provider)).await?;
    Ok(AgentStatus { provider, model, has_api_key })
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

/// An empty `model` selects the provider's default.
#[tauri::command]
pub async fn agent_set_model(
    state: State<'_, Arc<AppState>>,
    provider: Provider,
    model: String,
) -> Result<AgentStatus, String> {
    let model = match model.trim() {
        "" => default_model(provider),
        model => model,
    };
    let value = format!("{}:{model}", provider_id(provider));
    store::with_conn(&state, |conn| {
        database::upsert_setting(conn, MODEL_SETTING, &value)
            .map_err(store::StoreError::Settings)
    })
    .map_err(|e| e.to_string())?;
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
    actions: State<'_, Actions>,
    turns: State<'_, AgentTurns>,
    conversation_id: String,
    turn_id: String,
    text: String,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    let cancel = turns.begin(&conversation_id, &turn_id)?;

    let model = match store::with_conn(&state, |conn| model_setting(conn)) {
        Ok((provider, model)) => match credentials::get_credential(&key_name(provider)).await {
            Ok(api_key) => choose_model(provider, model, api_key),
            Err(err) => Err(TurnEnd::failed(AgentErrorKind::Internal, format!("reading the API key failed: {err}"))),
        },
        Err(err) => Err(TurnEnd::from(err)),
    };
    let scope = Arc::new(TurnScope {
        conversation_id,
        turn_id: turn_id.clone(),
        state: state.inner().clone(),
        actions: Arc::new(actions.inner().clone()) as Arc<dyn AgentActions>,
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
