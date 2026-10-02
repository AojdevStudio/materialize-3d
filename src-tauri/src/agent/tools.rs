//! Binds the registry's in-app tools ([`Tool::on`] with [`Surface::InAppAgent`])
//! to Rig for one turn.
//!
//! Every call is journaled as `started` before it runs, reported to the UI as
//! `ToolCall`, then `ToolProgress` (build_sign only), then `ToolResult`, and
//! journaled again with its outcome. A tool never fails the turn: errors go
//! back to the model and the UI as `{ "error": ... }` with `ok: false`.

use std::future::Future;
use std::sync::Arc;

use rig::agent::tool::{DynamicTool, ToolOutput};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use uuid::Uuid;

use super::protocol::{AgentEvent, ToolCallStatus};
use super::store;
use crate::state::AppState;
use crate::actions::RequestActions;
use crate::tools::{Surface, Tool, ToolCall, ToolError};

/// Sends one event to the turn's listener.
pub type Emit = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// Everything one turn's tool calls share.
pub struct TurnScope {
    pub conversation_id: String,
    pub turn_id: String,
    pub state: Arc<AppState>,
    pub actions: Arc<dyn RequestActions>,
    pub emit: Emit,
    pub cancel: CancellationToken,
    /// Blocking work started by tools. Cancelling drops a tool's future but not
    /// its blocking thread, so the turn waits on this before it reports.
    pub blocking: TaskTracker,
}

impl TurnScope {
    /// Journals a call, reports it to the UI, runs `body`, and records the
    /// outcome. The returned value is what the model sees.
    async fn journaled<F, Fut>(&self, tool: Tool, args: Value, body: F) -> Value
    where
        F: FnOnce(String, Value) -> Fut,
        Fut: Future<Output = Result<Value, String>>,
    {
        let call_id = Uuid::new_v4().to_string();
        let name = tool.name();
        let journaled = store::with_conn(&self.state, |conn| {
            store::start_tool_call(conn, &call_id, &self.conversation_id, &self.turn_id, name, &args)
        });
        (self.emit)(AgentEvent::ToolCall { call_id: call_id.clone(), name: name.into(), args: args.clone() });

        // Nothing runs unless its start is on disk, so a restart can always tell.
        let result = match journaled {
            Ok(()) => body(call_id.clone(), args).await,
            Err(err) => Err(format!("could not record the tool call: {err}")),
        };
        let (ok, output, status) = match result {
            Ok(output) => (true, output, ToolCallStatus::Completed),
            Err(error) => (false, json!({ "error": error }), ToolCallStatus::Failed),
        };
        if let Err(err) = store::with_conn(&self.state, |conn| store::finish_tool_call(conn, &call_id, status, &output)) {
            log::error!("agent: recording tool call {call_id} outcome failed: {err}");
        }
        (self.emit)(AgentEvent::ToolResult { call_id, ok, output: output.clone() });
        output
    }

    /// Runs `tool` as the in-app agent, reporting build progress under `call_id`.
    pub(crate) async fn invoke(&self, tool: Tool, call_id: String, args: Value) -> Result<Value, ToolError> {
        let emit = self.emit.clone();
        let call = ToolCall {
            surface: Surface::InAppAgent,
            actions: self.actions.clone(),
            progress: Arc::new(move |step| emit(AgentEvent::ToolProgress { call_id: call_id.clone(), step })),
            cancel: self.cancel.clone(),
            blocking: self.blocking.clone(),
        };
        tool.invoke(&call, args).await
    }
}

/// The Rig registrations for every in-app tool, bound to one turn.
pub fn bind_all(scope: &Arc<TurnScope>) -> Vec<DynamicTool> {
    Tool::on(Surface::InAppAgent).map(|tool| bind(tool, scope.clone())).collect()
}

fn bind(tool: Tool, scope: Arc<TurnScope>) -> DynamicTool {
    DynamicTool::new(tool.name(), tool.description(), tool.parameters().clone(), move |_context, args| {
        let scope = scope.clone();
        Box::pin(async move {
            let output = scope
                .journaled(tool, args, |call_id, args| async {
                    scope.invoke(tool, call_id, args).await.map_err(|e| e.to_string())
                })
                .await;
            Ok(ToolOutput::json(output))
        })
    })
}
