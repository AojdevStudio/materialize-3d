//! Wire contract between the Rust agent and the chat UI. Mirrored by
//! `src/types/agent.ts`; change both together.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fabrication::pipeline::BuildStep;

/// Streamed over a Tauri `Channel` for one turn, in order. Every turn ends with
/// exactly one of `TurnFinished`, `TurnCancelled`, or `Error`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    TurnStarted { conversation_id: String, turn_id: String },
    TextDelta { text: String },
    ToolCall { call_id: String, name: String, args: Value },
    /// Only `build` and `revise` report steps.
    ToolProgress { call_id: String, step: BuildStep },
    ToolResult { call_id: String, ok: bool, output: Value },
    TurnFinished,
    TurnCancelled,
    Error { kind: AgentErrorKind, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentErrorKind {
    /// No API key is stored for the selected provider; nothing was sent.
    MissingApiKey,
    /// The model provider rejected or failed the request.
    Provider,
    Internal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Anthropic,
    Openai,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub provider: Provider,
    pub model: String,
    /// The models offered for `provider`, default first.
    pub models: &'static [&'static str],
    pub has_api_key: bool,
}

/// One persisted chat entry, as the UI renders history after a restart.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "role", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HistoryEntry {
    User { id: String, text: String, created_at: String },
    Assistant { id: String, text: String, created_at: String },
    Tool {
        call_id: String,
        name: String,
        args: Value,
        status: ToolCallStatus,
        output: Option<Value>,
        created_at: String,
    },
}

/// A tool call's durable state. `Interrupted` means the app stopped while it
/// ran; it is shown to the person and never re-run automatically.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Started,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}
