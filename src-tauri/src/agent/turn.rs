//! One agent turn: stream the model, let it call tools, persist the exchange,
//! and report exactly one terminal event.
//!
//! Cancel drops the model stream, which drops any in-flight tool future. A
//! build keeps running on its blocking thread until it observes the cancel
//! flag, so the turn waits for that thread, then settles every unfinished call
//! as cancelled before it reports `TurnCancelled`.

use std::sync::Arc;

use futures::StreamExt;
use rig::agent::{MultiTurnStreamItem, StreamingError};
use rig::client::AgentClientExt;
use rig::completion::message::UserContent;
use rig::completion::{Message, PromptError};
use rig::providers::{anthropic, openai};
use rig::streaming::{StreamedAssistantContent, StreamingChat};
use serde_json::json;

use super::prompt::system_prompt;
use super::protocol::{AgentErrorKind, AgentEvent, Provider, ToolCallStatus};
use super::store::{self, StoreError, TextSegment};
use super::tools::{bind_all, TurnScope};
use crate::fabrication::kind::KindDriver;

/// Model calls per turn, including the call after each tool batch. It bounds
/// the repair loop. A part that needs describe, build, two repairs, and the
/// reply takes 5; PR 5's spike saw 8 of 10 hobbyist scripts build on the
/// first try and each failure repairable in one more build
/// (`cad-runtime/SPIKE-REPORT.md`, item 8). A clarifying question ends its
/// turn, so it never spends this budget.
pub const MAX_TURNS: usize = 8;
/// Anthropic requires an explicit output budget.
const ANTHROPIC_MAX_TOKENS: u64 = 8_192;

/// The model a turn talks to.
pub enum ModelChoice {
    Provider { provider: Provider, model: String, api_key: String },
    /// A scripted model for tests.
    #[cfg(test)]
    Scripted(rig::test_utils::MockCompletionModel),
    /// A scripted model whose next reply reads the request, for tests.
    #[cfg(test)]
    Responding(super::tests::Responder),
}

/// How a turn ended. Each turn reports exactly one, as its last event.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEnd {
    Finished,
    Cancelled,
    Failed { kind: AgentErrorKind, message: String },
}

impl TurnEnd {
    pub fn failed(kind: AgentErrorKind, message: impl Into<String>) -> Self {
        TurnEnd::Failed { kind, message: message.into() }
    }

    fn event(&self) -> AgentEvent {
        match self {
            TurnEnd::Finished => AgentEvent::TurnFinished,
            TurnEnd::Cancelled => AgentEvent::TurnCancelled,
            TurnEnd::Failed { kind, message } => AgentEvent::Error { kind: *kind, message: message.clone() },
        }
    }
}

impl From<StoreError> for TurnEnd {
    fn from(err: StoreError) -> Self {
        TurnEnd::failed(AgentErrorKind::Internal, err.to_string())
    }
}

impl From<StreamingError> for TurnEnd {
    fn from(err: StreamingError) -> Self {
        let kind = match &err {
            StreamingError::Completion(_) => AgentErrorKind::Provider,
            StreamingError::Prompt(prompt) => match prompt.as_ref() {
                PromptError::CompletionError(_) => AgentErrorKind::Provider,
                _ => AgentErrorKind::Internal,
            },
        };
        TurnEnd::failed(kind, err.to_string())
    }
}

fn build_agent(model: ModelChoice, scope: &Arc<TurnScope>, kinds: &[&'static dyn KindDriver]) -> Result<rig::Agent, TurnEnd> {
    let provider_error = |err: rig::http_client::Error| TurnEnd::failed(AgentErrorKind::Provider, err.to_string());
    let builder = match model {
        ModelChoice::Provider { provider: Provider::Anthropic, model, api_key } => anthropic::Client::new(&api_key)
            .map_err(provider_error)?
            .agent(model)
            .max_tokens(ANTHROPIC_MAX_TOKENS),
        ModelChoice::Provider { provider: Provider::Openai, model, api_key } => {
            openai::Client::new(&api_key).map_err(provider_error)?.agent(model)
        }
        #[cfg(test)]
        ModelChoice::Scripted(model) => rig::client::AgentModelExt::into_agent_builder(model),
        #[cfg(test)]
        ModelChoice::Responding(model) => rig::client::AgentModelExt::into_agent_builder(model),
    };
    Ok(builder
        .preamble(&system_prompt(kinds))
        .dynamic_tools(bind_all(scope, kinds))
        .default_max_turns(MAX_TURNS)
        .build())
}

/// Runs one turn and reports it through `scope.emit`: `TurnStarted`, then text
/// and tool events, then exactly one of `TurnFinished`, `TurnCancelled`, or
/// `Error`. `model` is `Err` when the turn cannot start (for example, no API
/// key); nothing is sent or stored then.
pub async fn run_turn(scope: Arc<TurnScope>, text: String, model: Result<ModelChoice, TurnEnd>) {
    (scope.emit)(AgentEvent::TurnStarted {
        conversation_id: scope.conversation_id.clone(),
        turn_id: scope.turn_id.clone(),
    });
    let mut user_message = None;
    let end = match model {
        Ok(model) => drive(&scope, &text, model, &mut user_message).await.err().unwrap_or(TurnEnd::Finished),
        Err(end) => end,
    };
    let end = settle(&scope, &text, user_message.as_deref(), end).await;
    (scope.emit)(end.event());
}

/// Text the person saw, split at tool calls so history interleaves correctly.
#[derive(Default)]
struct Segments {
    done: Vec<TextSegment>,
    open: Option<TextSegment>,
}

impl Segments {
    fn push(&mut self, text: &str) {
        match &mut self.open {
            Some(segment) => segment.text.push_str(text),
            None => self.open = Some(TextSegment { text: text.to_owned(), started_at: store::now() }),
        }
    }

    fn close(&mut self) {
        if let Some(segment) = self.open.take().filter(|s| !s.text.trim().is_empty()) {
            self.done.push(segment);
        }
    }

    fn finish(mut self) -> Vec<TextSegment> {
        self.close();
        self.done
    }
}

/// Streams the model until it finishes. `Ok` means the turn finished and was
/// stored; `Err` carries how it stopped otherwise.
async fn drive(
    scope: &Arc<TurnScope>,
    text: &str,
    model: ModelChoice,
    user_message: &mut Option<String>,
) -> Result<(), TurnEnd> {
    // The first call may verify the CAD runtime, so it runs off the async thread.
    let actions = scope.actions.clone();
    let kinds = scope
        .blocking
        .spawn_blocking(move || actions.kinds())
        .await
        .map_err(|e| TurnEnd::failed(AgentErrorKind::Internal, format!("listing the kinds failed: {e}")))?;
    let agent = build_agent(model, scope, &kinds)?;
    let (history, focus) = store::with_conn(&scope.state, |conn| {
        Ok((store::model_history(conn, &scope.conversation_id)?, store::focus_record(conn, &scope.conversation_id)?))
    })?;
    let id = store::with_conn(&scope.state, |conn| {
        store::insert_user_message(conn, &scope.conversation_id, &scope.turn_id, text)
    })?;
    let user_message = user_message.insert(id);

    let mut stream = agent.stream_chat(prompt(text, focus), history).max_turns(MAX_TURNS).await;
    let mut segments = Segments::default();
    loop {
        let item = tokio::select! {
            biased;
            _ = scope.cancel.cancelled() => return Err(TurnEnd::Cancelled),
            item = stream.next() => item,
        };
        let Some(item) = item else {
            return Err(TurnEnd::failed(AgentErrorKind::Internal, "the model stream ended without a final response"));
        };
        match item? {
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Text(delta)) => {
                segments.push(&delta.text);
                (scope.emit)(AgentEvent::TextDelta { text: delta.text });
            }
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ToolCall { .. }) => segments.close(),
            MultiTurnStreamItem::ModelTurnRetried { .. } => segments.open = None,
            MultiTurnStreamItem::FinalResponse(response) => {
                let transcript = turn_transcript(text, response.messages, &response.output);
                let segments = segments.finish();
                store::with_conn(&scope.state, |conn| {
                    store::finish_turn(conn, user_message, &scope.conversation_id, &scope.turn_id, &transcript, &segments)
                })?;
                return Ok(());
            }
            _ => {}
        }
    }
}

/// The person's message as the model reads it: the focus record, when there
/// is one, as its own text part before what the person wrote.
fn prompt(text: &str, focus: Option<String>) -> Message {
    match focus {
        Some(focus) => Message::User { content: vec![UserContent::text(focus), UserContent::text(text)] },
        None => Message::user(text),
    }
}

/// The messages this turn added, starting with the person's message as they
/// wrote it (without the focus record, which the next turn makes afresh) and
/// without images. Rig returns only the run's own messages (never the
/// history passed in), so they append to the stored history.
fn turn_transcript(text: &str, messages: Option<Vec<Message>>, output: &str) -> Vec<Message> {
    match messages {
        Some(mut messages) if !messages.is_empty() => {
            messages[0] = Message::user(text);
            store::without_images(messages)
        }
        _ => vec![Message::user(text), Message::assistant(output)],
    }
}

/// Waits for blocking tool work, settles calls that never reported, and
/// annotates the transcript of a turn that did not finish.
async fn settle(scope: &TurnScope, text: &str, user_message: Option<&str>, end: TurnEnd) -> TurnEnd {
    scope.blocking.close();
    scope.blocking.wait().await;

    let (status, output, note) = match &end {
        TurnEnd::Finished => (ToolCallStatus::Failed, json!({ "error": "the turn ended before this call reported" }), None),
        TurnEnd::Cancelled => (
            ToolCallStatus::Cancelled,
            json!({ "error": "cancelled by the person" }),
            Some("[The person cancelled this request before it finished. Nothing from it was said.]"),
        ),
        TurnEnd::Failed { .. } => (
            ToolCallStatus::Failed,
            json!({ "error": "the turn failed before this call finished" }),
            Some("[This request failed before a reply.]"),
        ),
    };
    let settled = store::with_conn(&scope.state, |conn| {
        let open = store::settle_open_calls(conn, &scope.turn_id, status, &output)?;
        if let (Some(id), Some(note)) = (user_message, note) {
            store::set_transcript(conn, id, &[Message::user(format!("{text}\n\n{note}"))])?;
        }
        Ok(open)
    });
    match settled {
        Ok(open) => {
            for call_id in open {
                (scope.emit)(AgentEvent::ToolResult { call_id, ok: false, output: output.clone() });
            }
            end
        }
        Err(err) => TurnEnd::failed(AgentErrorKind::Internal, format!("recording how the turn ended failed: {err}")),
    }
}
