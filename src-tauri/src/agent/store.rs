//! Durable agent conversations: the model transcript that continues a
//! conversation, the text the chat UI renders, and a journal of tool calls.
//!
//! Each user message row owns its turn's model transcript (`rig_json`): the
//! user message alone while the turn runs, the exchange once it finishes, or
//! the message plus a note when it was cancelled or failed. Assistant rows
//! are display text only, so nothing the model half-said is ever replayed to it.
//!
//! History replays text only: what the person said and what the model said,
//! never tool calls, tool results, or images. A one-line focus record
//! ([`focus_record`]) carries the last revision forward instead.

use chrono::SecondsFormat;
use rig::completion::message::{AssistantContent, Text, ToolResultContent, UserContent};
use rig::completion::Message;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

use super::protocol::{HistoryEntry, ToolCallStatus};
use crate::fabrication::kind::canonical_json;
use crate::fabrication::revisions::{self, RevisionError, RevisionId};
use crate::state::AppState;

pub const MIGRATION_005: &str = "
CREATE TABLE IF NOT EXISTS agent_conversations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    rig_json TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_messages_conversation ON agent_messages (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL,
    name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed', 'cancelled', 'interrupted')),
    output_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_tool_calls_conversation ON agent_tool_calls (conversation_id, started_at);
CREATE INDEX IF NOT EXISTS agent_tool_calls_status ON agent_tool_calls (status);
";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("stored agent data is malformed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("database is not initialized")]
    NoDatabase,
    #[error("database lock poisoned")]
    Poisoned,
    #[error("settings: {0}")]
    Settings(String),
    #[error("conversation {0} does not exist")]
    UnknownConversation(String),
    #[error("reading a revision: {0}")]
    Revision(#[from] RevisionError),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Runs `f` with the shared connection, holding the lock only for `f`.
pub fn with_conn<T>(state: &AppState, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    let mut guard = state.db.lock().map_err(|_| StoreError::Poisoned)?;
    f(guard.as_mut().ok_or(StoreError::NoDatabase)?)
}

/// Fixed-width UTC timestamps sort lexically in time order.
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true)
}

fn status_str(status: ToolCallStatus) -> &'static str {
    match status {
        ToolCallStatus::Started => "started",
        ToolCallStatus::Completed => "completed",
        ToolCallStatus::Failed => "failed",
        ToolCallStatus::Cancelled => "cancelled",
        ToolCallStatus::Interrupted => "interrupted",
    }
}

fn parse_status(status: &str) -> Result<ToolCallStatus> {
    Ok(serde_json::from_value(Value::String(status.to_owned()))?)
}

const INTERRUPTED_NOTE: &str =
    "[The app closed before this request finished. Tool calls it had started were interrupted and not re-run. Ask the person before trying again.]";

/// Settles work cut off by the app stopping. Runs at launch, before any turn.
/// A tool call still `started` is recorded as interrupted and never re-run,
/// and a turn whose transcript still holds only the person's message gets a
/// note, so the model does not read the request as untouched work and quietly
/// redo it. A transcript that no longer parses (a write cut short by the very
/// crash this recovers from) is treated the same way instead of blocking
/// launch. Returns the number of interrupted tool calls.
pub fn reconcile_interrupted(conn: &Connection) -> Result<usize> {
    let calls = conn.execute(
        "UPDATE agent_tool_calls SET status = 'interrupted', finished_at = ?1,
             output_json = '{\"error\":\"interrupted: the app stopped while this tool call ran\"}'
         WHERE status = 'started'",
        params![now()],
    )?;
    let mut stmt = conn.prepare("SELECT id, text, rig_json FROM agent_messages WHERE role = 'user' AND rig_json IS NOT NULL")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?;
    for row in rows {
        let (id, text, transcript) = row?;
        let unfinished = match serde_json::from_str::<Vec<Message>>(&transcript) {
            Ok(messages) => messages == [Message::user(text.as_str())],
            Err(err) => {
                log::warn!("agent message {id}: unreadable transcript treated as unfinished: {err}");
                true
            }
        };
        if unfinished {
            set_transcript(conn, &id, &[Message::user(format!("{text}\n\n{INTERRUPTED_NOTE}"))])?;
        }
    }
    Ok(calls)
}

pub fn new_conversation(conn: &Connection) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    conn.execute("INSERT INTO agent_conversations (id, created_at) VALUES (?1, ?2)", params![id, now()])?;
    Ok(id)
}

/// The most recently started conversation, created on first use.
pub fn current_conversation(conn: &Connection) -> Result<String> {
    let latest = conn
        .query_row("SELECT id FROM agent_conversations ORDER BY created_at DESC, rowid DESC LIMIT 1", [], |row| row.get(0))
        .optional()?;
    match latest {
        Some(id) => Ok(id),
        None => new_conversation(conn),
    }
}

fn require_conversation(conn: &Connection, id: &str) -> Result<()> {
    let found: Option<i64> =
        conn.query_row("SELECT 1 FROM agent_conversations WHERE id = ?1", params![id], |row| row.get(0)).optional()?;
    found.map(|_| ()).ok_or_else(|| StoreError::UnknownConversation(id.to_owned()))
}

/// What the person and the model said in earlier turns, in order, as text
/// only ([`text_only`]).
pub fn model_history(conn: &Connection, conversation_id: &str) -> Result<Vec<Message>> {
    require_conversation(conn, conversation_id)?;
    let mut stmt = conn.prepare(
        "SELECT rig_json FROM agent_messages WHERE conversation_id = ?1 AND rig_json IS NOT NULL
         ORDER BY created_at, rowid",
    )?;
    let transcripts = stmt.query_map(params![conversation_id], |row| row.get::<_, String>(0))?;
    let mut history = Vec::new();
    for transcript in transcripts {
        history.extend(serde_json::from_str::<Vec<Message>>(&transcript?)?);
    }
    Ok(text_only(history))
}

/// `messages` with every tool call, tool result, image, and reasoning block
/// dropped. A message left with no text is dropped too, and what the model
/// said around its tool calls in one turn joins into one reply.
pub fn text_only(messages: Vec<Message>) -> Vec<Message> {
    let texts = |parts: Vec<Option<String>>| parts.into_iter().flatten().collect::<Vec<_>>().join("\n\n");
    let mut said: Vec<(bool, String)> = Vec::new();
    for message in messages {
        let (user, text) = match message {
            Message::User { content } => (
                true,
                texts(content.into_iter().map(|c| if let UserContent::Text(Text { text, .. }) = c { Some(text) } else { None }).collect()),
            ),
            Message::Assistant { content, .. } => (
                false,
                texts(content.into_iter().map(|c| if let AssistantContent::Text(Text { text, .. }) = c { Some(text) } else { None }).collect()),
            ),
            Message::System { .. } => continue,
        };
        let text = text.trim();
        match said.last_mut() {
            _ if text.is_empty() => {}
            Some((false, last)) if !user => {
                last.push_str("\n\n");
                last.push_str(text);
            }
            _ => said.push((user, text.to_owned())),
        }
    }
    said.into_iter().map(|(user, text)| if user { Message::user(text) } else { Message::assistant(text) }).collect()
}

/// `messages` with every image dropped, tool results' included, so a stored
/// transcript never holds a build's views. Tool calls and their JSON stay.
pub fn without_images(messages: Vec<Message>) -> Vec<Message> {
    messages
        .into_iter()
        .map(|message| match message {
            Message::User { content } => Message::User {
                content: content
                    .into_iter()
                    .filter(|c| !matches!(c, UserContent::Image(_)))
                    .map(|c| match c {
                        UserContent::ToolResult(mut result) => {
                            result.content.retain(|part| !matches!(part, ToolResultContent::Image(_)));
                            UserContent::ToolResult(result)
                        }
                        other => other,
                    })
                    .collect(),
            },
            other => other,
        })
        .collect()
}

/// The one line that carries the conversation's last design into a new turn:
/// the newest revision a `build` or `revise` call returned, its kind, and its
/// spec as canonical JSON. `None` before the first build.
pub fn focus_record(conn: &Connection, conversation_id: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT output_json FROM agent_tool_calls
         WHERE conversation_id = ?1 AND name IN ('build', 'revise') AND status = 'completed' AND output_json IS NOT NULL
         ORDER BY started_at DESC, rowid DESC",
    )?;
    let outputs = stmt.query_map(params![conversation_id], |row| row.get::<_, String>(0))?;
    for output in outputs {
        let output: Value = serde_json::from_str(&output?)?;
        let Some(id) = output.get("revision_id").and_then(Value::as_str) else { continue };
        let revision = revisions::get(conn, &RevisionId::parse(id)?)?;
        return Ok(Some(format!(
            "[Focus: the last revision is {} (kind {}, revision {}), spec {}]",
            revision.id,
            revision.kind,
            revision.number,
            canonical_json(&revision.spec)
        )));
    }
    Ok(None)
}

/// Records the person's message as the turn starts. Returns the row id that
/// owns this turn's transcript.
pub fn insert_user_message(conn: &Connection, conversation_id: &str, turn_id: &str, text: &str) -> Result<String> {
    require_conversation(conn, conversation_id)?;
    let id = Uuid::new_v4().to_string();
    let transcript = serde_json::to_string(&[Message::user(text)])?;
    conn.execute(
        "INSERT INTO agent_messages (id, conversation_id, turn_id, role, text, rig_json, created_at)
         VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6)",
        params![id, conversation_id, turn_id, text, transcript, now()],
    )?;
    Ok(id)
}

/// Replaces the transcript a user message row carries into future turns.
pub fn set_transcript(conn: &Connection, user_message_id: &str, transcript: &[Message]) -> Result<()> {
    conn.execute(
        "UPDATE agent_messages SET rig_json = ?1 WHERE id = ?2",
        params![serde_json::to_string(transcript)?, user_message_id],
    )?;
    Ok(())
}

/// Assistant text the person saw, stamped when it started streaming.
#[derive(Debug, Clone, PartialEq)]
pub struct TextSegment {
    pub text: String,
    pub started_at: String,
}

/// Commits a finished turn: the full transcript for the model and the
/// assistant's text segments for the UI, atomically.
pub fn finish_turn(
    conn: &mut Connection,
    user_message_id: &str,
    conversation_id: &str,
    turn_id: &str,
    transcript: &[Message],
    segments: &[TextSegment],
) -> Result<()> {
    let tx = conn.transaction()?;
    set_transcript(&tx, user_message_id, transcript)?;
    for segment in segments {
        tx.execute(
            "INSERT INTO agent_messages (id, conversation_id, turn_id, role, text, rig_json, created_at)
             VALUES (?1, ?2, ?3, 'assistant', ?4, NULL, ?5)",
            params![Uuid::new_v4().to_string(), conversation_id, turn_id, segment.text, segment.started_at],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn start_tool_call(
    conn: &Connection,
    call_id: &str,
    conversation_id: &str,
    turn_id: &str,
    name: &str,
    args: &Value,
) -> Result<()> {
    conn.execute(
        "INSERT INTO agent_tool_calls (id, conversation_id, turn_id, name, args_json, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'started', ?6)",
        params![call_id, conversation_id, turn_id, name, serde_json::to_string(args)?, now()],
    )?;
    Ok(())
}

/// Records how a started call ended. A call already settled (for example by a
/// cancel) keeps its first outcome.
pub fn finish_tool_call(conn: &Connection, call_id: &str, status: ToolCallStatus, output: &Value) -> Result<()> {
    conn.execute(
        "UPDATE agent_tool_calls SET status = ?1, output_json = ?2, finished_at = ?3 WHERE id = ?4 AND status = 'started'",
        params![status_str(status), serde_json::to_string(output)?, now(), call_id],
    )?;
    Ok(())
}

/// Settles every call of a turn that never reported back (its future was
/// dropped). Returns the settled call ids in start order.
pub fn settle_open_calls(conn: &Connection, turn_id: &str, status: ToolCallStatus, output: &Value) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM agent_tool_calls WHERE turn_id = ?1 AND status = 'started' ORDER BY started_at, rowid",
    )?;
    let open = stmt.query_map(params![turn_id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &open {
        finish_tool_call(conn, id, status, output)?;
    }
    Ok(open)
}

/// The conversation as the chat UI renders it: messages and tool calls in the
/// order they happened.
pub fn history(conn: &Connection, conversation_id: &str) -> Result<Vec<HistoryEntry>> {
    require_conversation(conn, conversation_id)?;
    let mut entries: Vec<(String, HistoryEntry)> = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT id, role, text, created_at FROM agent_messages WHERE conversation_id = ?1 ORDER BY created_at, rowid",
    )?;
    let rows = stmt.query_map(params![conversation_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
    })?;
    for row in rows {
        let (id, role, text, created_at) = row?;
        let entry = if role == "user" {
            HistoryEntry::User { id, text, created_at: created_at.clone() }
        } else {
            HistoryEntry::Assistant { id, text, created_at: created_at.clone() }
        };
        entries.push((created_at, entry));
    }

    let mut stmt = conn.prepare(
        "SELECT id, name, args_json, status, output_json, started_at FROM agent_tool_calls
         WHERE conversation_id = ?1 ORDER BY started_at, rowid",
    )?;
    let rows = stmt.query_map(params![conversation_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    for row in rows {
        let (call_id, name, args, status, output, created_at) = row?;
        let entry = HistoryEntry::Tool {
            call_id,
            name,
            args: serde_json::from_str(&args)?,
            status: parse_status(&status)?,
            output: output.as_deref().map(serde_json::from_str).transpose()?,
            created_at: created_at.clone(),
        };
        entries.push((created_at, entry));
    }

    // Stable: at an identical instant a message sorts before a tool call.
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries.into_iter().map(|(_, entry)| entry).collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = crate::database::init_db(&dir.path().join("agent.db")).expect("init db");
        (dir, conn)
    }

    fn status_of(conn: &Connection, id: &str) -> String {
        conn.query_row("SELECT status FROM agent_tool_calls WHERE id = ?1", params![id], |row| row.get(0)).expect("row")
    }

    #[test]
    fn reconciliation_marks_started_calls_interrupted_and_leaves_settled_calls_alone() {
        let (_dir, conn) = db();
        let conversation = current_conversation(&conn).expect("conversation");
        start_tool_call(&conn, "running", &conversation, "t1", "build_sign", &json!({})).expect("start");
        start_tool_call(&conn, "done", &conversation, "t1", "list_signs", &json!({})).expect("start");
        finish_tool_call(&conn, "done", ToolCallStatus::Completed, &json!([])).expect("finish");

        assert_eq!(reconcile_interrupted(&conn).expect("reconcile"), 1);
        assert_eq!(status_of(&conn, "running"), "interrupted");
        assert_eq!(status_of(&conn, "done"), "completed");
        assert_eq!(reconcile_interrupted(&conn).expect("reconcile again"), 0, "idempotent");

        let entries = history(&conn, &conversation).expect("history");
        assert!(entries.iter().any(|entry| matches!(
            entry,
            HistoryEntry::Tool { call_id, status: ToolCallStatus::Interrupted, output: Some(_), .. } if call_id == "running"
        )));
    }

    #[test]
    fn after_a_crash_the_model_is_told_the_request_did_not_finish() {
        let (_dir, conn) = db();
        let conversation = current_conversation(&conn).expect("conversation");
        insert_user_message(&conn, &conversation, "t1", "make a sign").expect("user");
        insert_user_message(&conn, &conversation, "t2", "and a second one").expect("user");
        set_transcript(
            &conn,
            &conn.query_row("SELECT id FROM agent_messages WHERE turn_id = 't2'", [], |r| r.get::<_, String>(0)).expect("row"),
            &[Message::user("and a second one"), Message::assistant("Done.")],
        )
        .expect("finished turn");

        reconcile_interrupted(&conn).expect("reconcile");
        let history = model_history(&conn, &conversation).expect("history");
        assert_eq!(history[0], Message::user(format!("make a sign\n\n{INTERRUPTED_NOTE}")), "crashed turn is annotated");
        assert_eq!(history[1..], [Message::user("and a second one"), Message::assistant("Done.")], "finished turn untouched");

        reconcile_interrupted(&conn).expect("second reconcile");
        assert_eq!(model_history(&conn, &conversation).expect("history"), history, "reconcile is idempotent");
    }

    #[test]
    fn an_unreadable_transcript_does_not_block_launch_and_is_marked_unfinished() {
        let (_dir, conn) = db();
        let conversation = current_conversation(&conn).expect("conversation");
        insert_user_message(&conn, &conversation, "t1", "make a sign").expect("user");
        conn.execute("UPDATE agent_messages SET rig_json = '[{\"role\":\"us' WHERE turn_id = 't1'", [])
            .expect("truncate transcript");

        reconcile_interrupted(&conn).expect("reconcile survives a transcript cut short by a crash");
        assert_eq!(
            model_history(&conn, &conversation).expect("history"),
            vec![Message::user(format!("make a sign\n\n{INTERRUPTED_NOTE}"))],
            "the unreadable turn is treated as unfinished"
        );
    }

    #[test]
    fn a_turn_without_a_finish_leaves_only_the_users_message_in_the_model_history() {
        let (_dir, conn) = db();
        let conversation = current_conversation(&conn).expect("conversation");
        insert_user_message(&conn, &conversation, "t1", "make a sign").expect("user");
        assert_eq!(model_history(&conn, &conversation).expect("history"), vec![Message::user("make a sign")]);
        assert_eq!(current_conversation(&conn).expect("again"), conversation, "current conversation is stable");
        assert!(matches!(model_history(&conn, "nope"), Err(StoreError::UnknownConversation(_))));
    }
}
