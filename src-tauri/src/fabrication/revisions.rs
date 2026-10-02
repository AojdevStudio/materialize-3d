//! Durable record of sign revisions: what was built, from which spec, how it was
//! verified, and what a human approved.
//!
//! Three independent axes live on every revision and are never collapsed into one
//! status: the build (`BuildState`), the human approval of one exact package hash
//! (`Approval`), and the human-recorded physical print result (`PrintValidation`).
//! A successful slice says nothing about a physical print.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::checks::{CheckOutcome, PassedChecks};

pub const MIGRATION_004: &str = "
CREATE TABLE IF NOT EXISTS sign_revisions (
    id TEXT PRIMARY KEY,
    lineage_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    parent_id TEXT REFERENCES sign_revisions(id),
    title TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    spec_sha256 TEXT NOT NULL,
    build_key TEXT NOT NULL,
    requested_by TEXT NOT NULL CHECK (requested_by IN ('human', 'agent', 'external_mcp')),
    build_status TEXT NOT NULL CHECK (build_status IN ('building', 'verified', 'failed')),
    failure_reason TEXT,
    artifacts_json TEXT,
    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'void')),
    approved_sha256 TEXT,
    approval_at TEXT,
    void_reason TEXT,
    print_status TEXT NOT NULL DEFAULT 'not_tested' CHECK (print_status IN ('not_tested', 'passed', 'failed')),
    print_note TEXT,
    print_recorded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (lineage_id, number)
);
CREATE UNIQUE INDEX IF NOT EXISTS sign_revisions_live_build_key
    ON sign_revisions (lineage_id, build_key) WHERE build_status != 'failed' AND approval_status != 'void';
CREATE INDEX IF NOT EXISTS sign_revisions_created ON sign_revisions (created_at);
";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RevisionId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LineageId(String);

/// Lowercase hex SHA-256 digest.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Sha256Hex(String);

macro_rules! string_newtype {
    ($name:ident) => {
        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}
string_newtype!(RevisionId);
string_newtype!(LineageId);
string_newtype!(Sha256Hex);

impl RevisionId {
    pub fn parse(value: &str) -> Result<Self> {
        Uuid::parse_str(value)
            .map(|id| Self(id.to_string()))
            .map_err(|_| RevisionError::InvalidId(value.to_owned()))
    }
}

impl LineageId {
    pub fn parse(value: &str) -> Result<Self> {
        Uuid::parse_str(value)
            .map(|id| Self(id.to_string()))
            .map_err(|_| RevisionError::InvalidId(value.to_owned()))
    }

    fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl TryFrom<String> for Sha256Hex {
    type Error = RevisionError;

    fn try_from(value: String) -> std::result::Result<Self, Self::Error> {
        let valid = value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if valid {
            Ok(Self(value))
        } else {
            Err(RevisionError::InvalidHash(value))
        }
    }
}

impl From<Sha256Hex> for String {
    fn from(value: Sha256Hex) -> Self {
        value.0
    }
}

impl Sha256Hex {
    pub fn of_bytes(bytes: &[u8]) -> Self {
        Self(hex(&Sha256::digest(bytes)))
    }

    pub fn of_file(path: &Path) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(Self(hex(&hasher.finalize())))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Who asked for an action. Only `Human` may approve or record a print result;
/// agents and external MCP callers can request builds and read state.
/// Serialize-only: no request body or tool argument can deserialize into one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Human,
    Agent,
    ExternalMcp,
}

impl Actor {
    fn as_db(self) -> &'static str {
        match self {
            Actor::Human => "human",
            Actor::Agent => "agent",
            Actor::ExternalMcp => "external_mcp",
        }
    }

    fn from_db(value: &str) -> Result<Self> {
        match value {
            "human" => Ok(Actor::Human),
            "agent" => Ok(Actor::Agent),
            "external_mcp" => Ok(Actor::ExternalMcp),
            other => Err(RevisionError::Corrupt(format!("requested_by {other}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlicerIdentity {
    pub name: String,
    pub version: String,
    pub profile_version: String,
}

/// One verification result. `id` is the check's stable name (for example
/// `placement_preserved`); the producing module owns the vocabulary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordedCheck {
    pub id: String,
    pub passed: bool,
    pub detail: String,
}

impl From<&CheckOutcome> for RecordedCheck {
    fn from(outcome: &CheckOutcome) -> Self {
        Self { id: outcome.id.to_string(), passed: outcome.passed, detail: outcome.detail.clone() }
    }
}

/// Everything a finished build produced. Paths are absolute and live inside the
/// revision's own directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Artifacts {
    pub revision_dir: PathBuf,
    pub package_path: PathBuf,
    pub package_sha256: Sha256Hex,
    pub preview_path: PathBuf,
    pub slice_dir: PathBuf,
    pub gcode_sha256: Sha256Hex,
    pub slicer: SlicerIdentity,
    pub effective_settings: serde_json::Value,
    pub checks: Vec<RecordedCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BuildState {
    Building,
    Verified { artifacts: Box<Artifacts> },
    Failed { reason: String, artifacts: Option<Box<Artifacts>> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Approval {
    Pending,
    Approved { package_sha256: Sha256Hex, at: String },
    Void { reason: String, at: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PrintValidation {
    NotTested,
    Passed { at: String, note: String },
    Failed { at: String, note: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SignRevision {
    pub id: RevisionId,
    pub lineage_id: LineageId,
    pub number: u32,
    pub parent_id: Option<RevisionId>,
    pub title: String,
    pub spec: serde_json::Value,
    pub spec_sha256: Sha256Hex,
    pub build_key: Sha256Hex,
    pub requested_by: Actor,
    pub build: BuildState,
    pub approval: Approval,
    pub print_validation: PrintValidation,
    pub created_at: String,
    pub updated_at: String,
}

impl SignRevision {
    pub fn artifacts(&self) -> Option<&Artifacts> {
        match &self.build {
            BuildState::Verified { artifacts } => Some(artifacts),
            BuildState::Failed { artifacts, .. } => artifacts.as_deref(),
            BuildState::Building => None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RevisionError {
    #[error("revision {0} not found")]
    NotFound(String),
    #[error("invalid id {0}")]
    InvalidId(String),
    #[error("invalid sha256 {0}")]
    InvalidHash(String),
    #[error("only a person can {0}; agents and external callers cannot")]
    HumanOnly(&'static str),
    #[error("revision {0} is not verified")]
    NotVerified(String),
    #[error("revision {0} has failing checks and cannot be approved")]
    ChecksFailed(String),
    #[error("package hash mismatch: expected {expected}, found {actual}")]
    HashMismatch { expected: String, actual: String },
    #[error("approval for revision {0} is void: {1}")]
    ApprovalVoid(String, String),
    #[error("revision {0} is not approved")]
    NotApproved(String),
    #[error("refusing to overwrite existing file {0}")]
    WouldOverwrite(PathBuf),
    #[error("revision {id} is {state}, cannot {action}")]
    InvalidTransition { id: String, state: &'static str, action: &'static str },
    #[error("corrupt revision row: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, RevisionError>;

#[derive(Clone)]
pub struct NewBuild {
    /// `None` starts a new sign; `Some` adds a revision to an existing sign.
    pub lineage_id: Option<LineageId>,
    pub title: String,
    pub spec: serde_json::Value,
    pub spec_sha256: Sha256Hex,
    /// Hash of every input that determines the output (spec, template, fonts,
    /// slicer version). Identical keys within one sign reuse the live revision.
    pub build_key: Sha256Hex,
    pub requested_by: Actor,
}

#[derive(Debug)]
pub enum BuildClaim {
    /// A new `Building` row the caller must finish with `complete_build` or `fail_build`.
    Started(SignRevision),
    /// A live revision (building, or verified without a void approval) with the
    /// same build key already exists.
    Existing(SignRevision),
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

/// Claims a revision for `build`, or returns the live revision that already has
/// the same build key. Safe to call repeatedly with the same input.
pub fn claim_build(conn: &mut Connection, build: NewBuild) -> Result<BuildClaim> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let lookup_existing = |tx: &rusqlite::Transaction<'_>, lineage: Option<&LineageId>| -> Result<Option<SignRevision>> {
        let sql = format!(
            "{SELECT} WHERE build_key = ?1 AND build_status != 'failed' AND approval_status != 'void'
             AND (?2 IS NULL OR lineage_id = ?2) ORDER BY created_at LIMIT 1"
        );
        tx.query_row(&sql, params![build.build_key.as_str(), lineage.map(LineageId::as_str)], row_to_revision)
            .optional()?
            .transpose()
    };
    if let Some(existing) = lookup_existing(&tx, build.lineage_id.as_ref())? {
        tx.commit()?;
        return Ok(BuildClaim::Existing(existing));
    }

    let lineage = build.lineage_id.clone().unwrap_or_else(LineageId::new);
    let (number, parent): (u32, Option<String>) = tx
        .query_row(
            "SELECT number, id FROM sign_revisions WHERE lineage_id = ?1 ORDER BY number DESC LIMIT 1",
            params![lineage.as_str()],
            |row| Ok((row.get::<_, u32>(0)? + 1, Some(row.get::<_, String>(1)?))),
        )
        .optional()?
        .unwrap_or((1, None));
    if build.lineage_id.is_some() && parent.is_none() {
        return Err(RevisionError::NotFound(format!("sign {lineage}")));
    }

    let id = RevisionId(Uuid::new_v4().to_string());
    let stamp = now();
    tx.execute(
        "INSERT INTO sign_revisions (id, lineage_id, number, parent_id, title, spec_json, spec_sha256, build_key,
             requested_by, build_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'building', ?10, ?10)",
        params![
            id.as_str(),
            lineage.as_str(),
            number,
            parent,
            build.title,
            serde_json::to_string(&build.spec)?,
            build.spec_sha256.as_str(),
            build.build_key.as_str(),
            build.requested_by.as_db(),
            stamp,
        ],
    )?;
    let revision = get_tx(&tx, &id)?;
    tx.commit()?;
    Ok(BuildClaim::Started(revision))
}

/// Records a build whose every planned check passed. Only a check plan makes a
/// [`PassedChecks`], so this is the one way a build becomes `Verified`. The
/// recorded checks are always the proof's outcomes; `artifacts.checks` is
/// replaced with them.
///
/// ```
/// use materialize_3d_lib::fabrication::checks::PassedChecks;
/// use materialize_3d_lib::fabrication::revisions::{self, Artifacts, Result, RevisionId, SignRevision};
/// fn record(conn: &rusqlite::Connection, id: &RevisionId, artifacts: Artifacts, passed: &PassedChecks) -> Result<SignRevision> {
///     revisions::finish_verified(conn, id, artifacts, passed)
/// }
/// ```
///
/// A plain list of passing checks is not proof and does not compile:
///
/// ```compile_fail,E0308
/// use materialize_3d_lib::fabrication::revisions::{self, Artifacts, RecordedCheck, Result, RevisionId, SignRevision};
/// fn record(conn: &rusqlite::Connection, id: &RevisionId, artifacts: Artifacts, checks: Vec<RecordedCheck>) -> Result<SignRevision> {
///     revisions::finish_verified(conn, id, artifacts, checks)
/// }
/// ```
pub fn finish_verified(conn: &Connection, id: &RevisionId, artifacts: Artifacts, passed: &PassedChecks) -> Result<SignRevision> {
    let checks = passed.outcomes().iter().map(RecordedCheck::from).collect();
    record_finish(conn, id, "verified", None, &Artifacts { checks, ..artifacts })
}

/// Records a build whose checks ran and did not all pass. The revision is
/// `Failed` with its evidence kept, whatever `artifacts.checks` holds.
pub fn finish_failed(conn: &Connection, id: &RevisionId, artifacts: Artifacts) -> Result<SignRevision> {
    let failed: Vec<&str> = artifacts.checks.iter().filter(|c| !c.passed).map(|c| c.id.as_str()).collect();
    let reason = format!("checks failed: {}", failed.join(", "));
    record_finish(conn, id, "failed", Some(reason), &artifacts)
}

fn record_finish(conn: &Connection, id: &RevisionId, status: &str, reason: Option<String>, artifacts: &Artifacts) -> Result<SignRevision> {
    let changed = conn.execute(
        "UPDATE sign_revisions SET build_status = ?2, failure_reason = ?3, artifacts_json = ?4, updated_at = ?5
         WHERE id = ?1 AND build_status = 'building'",
        params![id.as_str(), status, reason, serde_json::to_string(artifacts)?, now()],
    )?;
    ensure_transition(conn, id, changed, "finish the build of")?;
    get(conn, id)
}

pub fn fail_build(conn: &Connection, id: &RevisionId, reason: &str) -> Result<SignRevision> {
    let changed = conn.execute(
        "UPDATE sign_revisions SET build_status = 'failed', failure_reason = ?2, updated_at = ?3
         WHERE id = ?1 AND build_status = 'building'",
        params![id.as_str(), reason, now()],
    )?;
    ensure_transition(conn, id, changed, "fail")?;
    get(conn, id)
}

/// Builds still recorded as running. At startup these are builds the app
/// stopped in the middle of; none of them has artifacts on record.
pub fn unfinished_builds(conn: &Connection) -> Result<Vec<RevisionId>> {
    let mut stmt = conn.prepare("SELECT id FROM sign_revisions WHERE build_status = 'building'")?;
    let ids = stmt.query_map([], |row| row.get::<_, String>(0).map(RevisionId))?;
    Ok(ids.collect::<rusqlite::Result<_>>()?)
}

/// Marks builds left running by a crash or quit as failed. Run once at startup
/// before anything can claim new builds. Returns how many rows changed.
pub fn reconcile_interrupted(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE sign_revisions SET build_status = 'failed',
             failure_reason = 'interrupted: the app stopped before this build finished', updated_at = ?1
         WHERE build_status = 'building'",
        params![now()],
    )?)
}

/// Approves exactly the package the person reviewed. `expected` is the hash the
/// UI displayed; the file on disk must still match it.
pub fn approve(conn: &Connection, id: &RevisionId, expected: &Sha256Hex, actor: Actor) -> Result<SignRevision> {
    if actor != Actor::Human {
        return Err(RevisionError::HumanOnly("approve a sign revision"));
    }
    let revision = get(conn, id)?;
    let artifacts = match &revision.build {
        BuildState::Verified { artifacts } => artifacts,
        BuildState::Failed { .. } => return Err(RevisionError::ChecksFailed(id.to_string())),
        BuildState::Building => return Err(RevisionError::NotVerified(id.to_string())),
    };
    if &artifacts.package_sha256 != expected {
        return Err(RevisionError::HashMismatch {
            expected: expected.to_string(),
            actual: artifacts.package_sha256.to_string(),
        });
    }
    let on_disk = Sha256Hex::of_file(&artifacts.package_path)?;
    if &on_disk != expected {
        void(conn, id, "the package file changed on disk before approval")?;
        return Err(RevisionError::HashMismatch { expected: expected.to_string(), actual: on_disk.to_string() });
    }
    match &revision.approval {
        Approval::Approved { package_sha256, .. } if package_sha256 == expected => return Ok(revision),
        Approval::Approved { .. } => return Err(RevisionError::Corrupt(format!("{id} approved for another hash"))),
        Approval::Void { reason, .. } => return Err(RevisionError::ApprovalVoid(id.to_string(), reason.clone())),
        Approval::Pending => {}
    }
    conn.execute(
        "UPDATE sign_revisions SET approval_status = 'approved', approved_sha256 = ?2, approval_at = ?3, updated_at = ?3
         WHERE id = ?1 AND approval_status = 'pending'",
        params![id.as_str(), expected.as_str(), now()],
    )?;
    get(conn, id)
}

/// Re-hashes an approved package. A changed file voids the approval permanently;
/// a fresh build and a fresh approval are required.
pub fn check_integrity(conn: &Connection, id: &RevisionId) -> Result<SignRevision> {
    let revision = get(conn, id)?;
    if let (Approval::Approved { package_sha256, .. }, Some(artifacts)) = (&revision.approval, revision.artifacts()) {
        let on_disk = match Sha256Hex::of_file(&artifacts.package_path) {
            Ok(hash) => Some(hash),
            Err(err) if err.kind() == io::ErrorKind::NotFound => None,
            Err(err) => return Err(err.into()),
        };
        if on_disk.as_ref() != Some(package_sha256) {
            let reason = match on_disk {
                Some(actual) => format!("package changed on disk after approval (now {actual})"),
                None => "package file is missing".to_owned(),
            };
            void(conn, id, &reason)?;
            return get(conn, id);
        }
    }
    Ok(revision)
}

fn void(conn: &Connection, id: &RevisionId, reason: &str) -> Result<()> {
    conn.execute(
        "UPDATE sign_revisions SET approval_status = 'void', void_reason = ?2, approval_at = ?3, updated_at = ?3
         WHERE id = ?1",
        params![id.as_str(), reason, now()],
    )?;
    Ok(())
}

/// Copies an approved package to `destination`. Never overwrites.
pub fn export(conn: &Connection, id: &RevisionId, destination: &Path) -> Result<PathBuf> {
    let revision = check_integrity(conn, id)?;
    let approved = match &revision.approval {
        Approval::Approved { package_sha256, .. } => package_sha256.clone(),
        Approval::Void { reason, .. } => return Err(RevisionError::ApprovalVoid(id.to_string(), reason.clone())),
        Approval::Pending => return Err(RevisionError::NotApproved(id.to_string())),
    };
    let artifacts = revision.artifacts().ok_or_else(|| RevisionError::NotVerified(id.to_string()))?;
    match copy_verified(&artifacts.package_path, destination, &approved) {
        Err(RevisionError::HashMismatch { expected, actual }) => {
            void(conn, id, &format!("package changed during export (now {actual})"))?;
            Err(RevisionError::HashMismatch { expected, actual })
        }
        other => other,
    }
}

/// Copies `source` to `destination` only if the copy hashes to `expected`.
/// The bytes go to a temporary file beside the destination first, so a failed
/// or mismatched copy never leaves a partial or wrong file behind, and the
/// final step refuses to replace an existing file.
fn copy_verified(source: &Path, destination: &Path, expected: &Sha256Hex) -> Result<PathBuf> {
    if destination.exists() {
        return Err(RevisionError::WouldOverwrite(destination.to_path_buf()));
    }
    let parent = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    io::copy(&mut File::open(source)?, staged.as_file_mut())?;
    staged.as_file().sync_all()?;
    let copied = Sha256Hex::of_file(staged.path())?;
    if &copied != expected {
        return Err(RevisionError::HashMismatch { expected: expected.to_string(), actual: copied.to_string() });
    }
    staged.persist_noclobber(destination).map_err(|err| match err.error.kind() {
        io::ErrorKind::AlreadyExists => RevisionError::WouldOverwrite(destination.to_path_buf()),
        _ => RevisionError::Io(err.error),
    })?;
    Ok(destination.to_path_buf())
}

/// Records what happened when the sign was physically printed. Person only.
pub fn record_print_result(conn: &Connection, id: &RevisionId, passed: bool, note: &str, actor: Actor) -> Result<SignRevision> {
    if actor != Actor::Human {
        return Err(RevisionError::HumanOnly("record a physical print result"));
    }
    let revision = get(conn, id)?;
    if !matches!(revision.build, BuildState::Verified { .. }) {
        return Err(RevisionError::NotVerified(id.to_string()));
    }
    conn.execute(
        "UPDATE sign_revisions SET print_status = ?2, print_note = ?3, print_recorded_at = ?4, updated_at = ?4 WHERE id = ?1",
        params![id.as_str(), if passed { "passed" } else { "failed" }, note, now()],
    )?;
    get(conn, id)
}

pub fn get(conn: &Connection, id: &RevisionId) -> Result<SignRevision> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), params![id.as_str()], row_to_revision)
        .optional()?
        .ok_or_else(|| RevisionError::NotFound(id.to_string()))?
}

fn get_tx(tx: &rusqlite::Transaction<'_>, id: &RevisionId) -> Result<SignRevision> {
    tx.query_row(&format!("{SELECT} WHERE id = ?1"), params![id.as_str()], row_to_revision)?
}

pub fn list_lineage(conn: &Connection, lineage: &LineageId) -> Result<Vec<SignRevision>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE lineage_id = ?1 ORDER BY number DESC"))?;
    let rows = stmt.query_map(params![lineage.as_str()], row_to_revision)?;
    rows.map(|row| row?).collect()
}

pub fn list_recent(conn: &Connection, limit: u32) -> Result<Vec<SignRevision>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY created_at DESC LIMIT ?1"))?;
    let rows = stmt.query_map(params![limit], row_to_revision)?;
    rows.map(|row| row?).collect()
}

fn ensure_transition(conn: &Connection, id: &RevisionId, changed: usize, action: &'static str) -> Result<()> {
    if changed == 1 {
        return Ok(());
    }
    let state = get(conn, id)?;
    Err(RevisionError::InvalidTransition {
        id: id.to_string(),
        state: match state.build {
            BuildState::Building => "building",
            BuildState::Verified { .. } => "verified",
            BuildState::Failed { .. } => "failed",
        },
        action,
    })
}

const SELECT: &str = "SELECT id, lineage_id, number, parent_id, title, spec_json, spec_sha256, build_key, requested_by,
    build_status, failure_reason, artifacts_json, approval_status, approved_sha256, approval_at, void_reason,
    print_status, print_note, print_recorded_at, created_at, updated_at FROM sign_revisions";

/// Parses one row into the typed model. The outer `rusqlite::Result` carries
/// column access errors; the inner one carries domain-level corruption.
fn row_to_revision(row: &Row<'_>) -> rusqlite::Result<Result<SignRevision>> {
    let text = |index: usize| row.get::<_, String>(index);
    let optional = |index: usize| row.get::<_, Option<String>>(index);
    let (id, lineage, number, parent) = (text(0)?, text(1)?, row.get::<_, u32>(2)?, optional(3)?);
    let (title, spec_json, spec_sha, build_key, requested_by) = (text(4)?, text(5)?, text(6)?, text(7)?, text(8)?);
    let (build_status, failure_reason, artifacts_json) = (text(9)?, optional(10)?, optional(11)?);
    let (approval_status, approved_sha, approval_at, void_reason) = (text(12)?, optional(13)?, optional(14)?, optional(15)?);
    let (print_status, print_note, print_at) = (text(16)?, optional(17)?, optional(18)?);
    let (created_at, updated_at) = (text(19)?, text(20)?);

    Ok((|| {
        let artifacts = artifacts_json
            .map(|json| serde_json::from_str::<Artifacts>(&json).map(Box::new))
            .transpose()?;
        let build = match (build_status.as_str(), artifacts) {
            ("building", _) => BuildState::Building,
            ("verified", Some(artifacts)) => BuildState::Verified { artifacts },
            ("failed", artifacts) => BuildState::Failed {
                reason: failure_reason.unwrap_or_default(),
                artifacts,
            },
            (other, _) => return Err(RevisionError::Corrupt(format!("{id} build_status {other}"))),
        };
        let approval = match (approval_status.as_str(), approved_sha, approval_at) {
            ("pending", _, _) => Approval::Pending,
            ("approved", Some(sha), Some(at)) => Approval::Approved { package_sha256: Sha256Hex::try_from(sha)?, at },
            ("void", _, at) => Approval::Void { reason: void_reason.unwrap_or_default(), at: at.unwrap_or_default() },
            (other, _, _) => return Err(RevisionError::Corrupt(format!("{id} approval_status {other}"))),
        };
        let print_validation = match print_status.as_str() {
            "not_tested" => PrintValidation::NotTested,
            "passed" => PrintValidation::Passed { at: print_at.unwrap_or_default(), note: print_note.unwrap_or_default() },
            "failed" => PrintValidation::Failed { at: print_at.unwrap_or_default(), note: print_note.unwrap_or_default() },
            other => return Err(RevisionError::Corrupt(format!("{id} print_status {other}"))),
        };
        Ok(SignRevision {
            id: RevisionId(id),
            lineage_id: LineageId(lineage),
            number,
            parent_id: parent.map(RevisionId),
            title,
            spec: serde_json::from_str(&spec_json)?,
            spec_sha256: Sha256Hex::try_from(spec_sha)?,
            build_key: Sha256Hex::try_from(build_key)?,
            requested_by: Actor::from_db(&requested_by)?,
            build,
            approval,
            print_validation,
            created_at,
            updated_at,
        })
    })())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(MIGRATION_004).expect("migration");
        conn
    }

    fn sha(seed: &str) -> Sha256Hex {
        Sha256Hex::of_bytes(seed.as_bytes())
    }

    fn request(key: &str, lineage: Option<LineageId>, actor: Actor) -> NewBuild {
        NewBuild {
            lineage_id: lineage,
            title: "Back shortly".into(),
            spec: serde_json::json!({ "text": key }),
            spec_sha256: sha(key),
            build_key: sha(key),
            requested_by: actor,
        }
    }

    fn started(claim: BuildClaim) -> SignRevision {
        match claim {
            BuildClaim::Started(revision) => revision,
            BuildClaim::Existing(revision) => panic!("expected a new revision, got existing {}", revision.id),
        }
    }

    fn artifacts(dir: &Path, contents: &[u8], checks_pass: bool) -> Artifacts {
        let package_path = dir.join("package.3mf");
        fs::write(&package_path, contents).expect("write package");
        Artifacts {
            revision_dir: dir.to_path_buf(),
            package_sha256: Sha256Hex::of_bytes(contents),
            package_path,
            preview_path: dir.join("preview.png"),
            slice_dir: dir.join("slice"),
            gcode_sha256: sha("gcode"),
            slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "02.08.00.05".into() },
            effective_settings: serde_json::json!({}),
            checks: vec![
                RecordedCheck { id: "slice_succeeded".into(), passed: true, detail: "return_code 0".into() },
                RecordedCheck { id: "placement_preserved".into(), passed: checks_pass, detail: "max deviation".into() },
            ],
        }
    }

    /// Proof that both checks `artifacts` records passed.
    fn passed() -> PassedChecks {
        let slice = |check| crate::fabrication::checks::slice_check_id(check);
        crate::fabrication::checks::test_support::passed(&[
            slice(crate::fabrication::bambu::CheckId::SliceSucceeded),
            slice(crate::fabrication::bambu::CheckId::PlacementPreserved),
        ])
    }

    fn verified(conn: &mut Connection, dir: &Path, key: &str) -> SignRevision {
        let revision = started(claim_build(conn, request(key, None, Actor::Agent)).expect("claim"));
        finish_verified(conn, &revision.id, artifacts(dir, key.as_bytes(), true), &passed()).expect("finish")
    }

    #[test]
    fn same_build_key_reuses_the_live_revision() {
        let mut conn = db();
        let first = started(claim_build(&mut conn, request("a", None, Actor::Agent)).expect("claim"));
        match claim_build(&mut conn, request("a", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim") {
            BuildClaim::Existing(existing) => assert_eq!(existing.id, first.id),
            BuildClaim::Started(revision) => panic!("duplicate revision {}", revision.id),
        }
        match claim_build(&mut conn, request("a", None, Actor::Human)).expect("claim") {
            BuildClaim::Existing(existing) => assert_eq!(existing.id, first.id, "retry without lineage finds it too"),
            BuildClaim::Started(revision) => panic!("duplicate revision {}", revision.id),
        }
    }

    #[test]
    fn a_failed_build_can_be_retried_as_a_new_revision() {
        let mut conn = db();
        let first = started(claim_build(&mut conn, request("a", None, Actor::Agent)).expect("claim"));
        fail_build(&conn, &first.id, "slicer crashed").expect("fail");
        let retry = started(claim_build(&mut conn, request("a", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
        assert_eq!(retry.number, 2);
        assert_eq!(retry.parent_id.as_ref(), Some(&first.id));
    }

    #[test]
    fn a_changed_spec_starts_a_new_pending_revision_in_the_same_sign() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let first = verified(&mut conn, dir.path(), "a");
        approve(&conn, &first.id, &first.artifacts().expect("artifacts").package_sha256, Actor::Human).expect("approve");
        let second = started(claim_build(&mut conn, request("b", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
        assert_eq!(second.number, 2);
        assert_eq!(second.approval, Approval::Pending);
    }

    #[test]
    fn only_a_person_can_approve_and_only_the_reviewed_hash() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = verified(&mut conn, dir.path(), "a");
        let hash = revision.artifacts().expect("artifacts").package_sha256.clone();
        for actor in [Actor::Agent, Actor::ExternalMcp] {
            assert!(matches!(approve(&conn, &revision.id, &hash, actor), Err(RevisionError::HumanOnly(_))));
        }
        assert!(matches!(approve(&conn, &revision.id, &sha("other"), Actor::Human), Err(RevisionError::HashMismatch { .. })));
        let approved = approve(&conn, &revision.id, &hash, Actor::Human).expect("approve");
        assert!(matches!(approved.approval, Approval::Approved { ref package_sha256, .. } if *package_sha256 == hash));
    }

    /// A list of passing checks is not proof: without `PassedChecks` the build
    /// is recorded as failed, and the recorded checks are the proof's, not the caller's.
    #[test]
    fn only_passed_checks_record_a_verified_build() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = started(claim_build(&mut conn, request("a", None, Actor::Agent)).expect("claim"));
        let finished = finish_failed(&conn, &revision.id, artifacts(dir.path(), b"pkg", true)).expect("finish");
        assert!(matches!(finished.build, BuildState::Failed { .. }), "a plain passing list does not verify");

        let revision = started(claim_build(&mut conn, request("b", None, Actor::Agent)).expect("claim"));
        let mut claimed = artifacts(dir.path(), b"pkg", true);
        claimed.checks.push(RecordedCheck { id: "slice.made_up".into(), passed: true, detail: String::new() });
        let finished = finish_verified(&conn, &revision.id, claimed, &passed()).expect("finish");
        let ids: Vec<&str> = finished.artifacts().expect("artifacts").checks.iter().map(|c| c.id.as_str()).collect();
        assert!(matches!(finished.build, BuildState::Verified { .. }));
        assert_eq!(ids, ["slice.slice_succeeded", "slice.placement_preserved"]);
    }

    #[test]
    fn a_revision_with_a_failing_check_cannot_be_approved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = started(claim_build(&mut conn, request("a", None, Actor::Agent)).expect("claim"));
        let finished = finish_failed(&conn, &revision.id, artifacts(dir.path(), b"pkg", false)).expect("finish");
        assert!(matches!(finished.build, BuildState::Failed { ref reason, .. } if reason.contains("placement_preserved")));
        let hash = finished.artifacts().expect("artifacts").package_sha256.clone();
        assert!(matches!(approve(&conn, &revision.id, &hash, Actor::Human), Err(RevisionError::ChecksFailed(_))));
    }

    #[test]
    fn changing_the_file_after_approval_voids_it_and_blocks_export() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = verified(&mut conn, dir.path(), "a");
        let artifacts = revision.artifacts().expect("artifacts").clone();
        approve(&conn, &revision.id, &artifacts.package_sha256, Actor::Human).expect("approve");
        fs::write(&artifacts.package_path, b"tampered").expect("tamper");
        let checked = check_integrity(&conn, &revision.id).expect("integrity");
        assert!(matches!(checked.approval, Approval::Void { .. }));
        let target = dir.path().join("out/sign.3mf");
        assert!(matches!(export(&conn, &revision.id, &target), Err(RevisionError::ApprovalVoid(..))));
        assert!(!target.exists());
    }

    #[test]
    fn export_requires_approval_and_never_overwrites() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = verified(&mut conn, dir.path(), "a");
        let target = dir.path().join("out/sign.3mf");
        assert!(matches!(export(&conn, &revision.id, &target), Err(RevisionError::NotApproved(_))));
        let hash = revision.artifacts().expect("artifacts").package_sha256.clone();
        approve(&conn, &revision.id, &hash, Actor::Human).expect("approve");
        export(&conn, &revision.id, &target).expect("export");
        assert_eq!(Sha256Hex::of_file(&target).expect("hash"), hash);
        assert!(matches!(export(&conn, &revision.id, &target), Err(RevisionError::WouldOverwrite(_))));
    }

    #[test]
    fn a_void_approval_does_not_block_rebuilding_the_same_spec() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = verified(&mut conn, dir.path(), "a");
        let artifacts = revision.artifacts().expect("artifacts").clone();
        approve(&conn, &revision.id, &artifacts.package_sha256, Actor::Human).expect("approve");
        fs::remove_file(&artifacts.package_path).expect("package lost");
        assert!(matches!(check_integrity(&conn, &revision.id).expect("integrity").approval, Approval::Void { .. }));
        let rebuilt = started(claim_build(&mut conn, request("a", Some(revision.lineage_id.clone()), Actor::Agent)).expect("claim"));
        assert_eq!(rebuilt.number, 2);
        assert_eq!(rebuilt.approval, Approval::Pending);
    }

    #[test]
    fn a_copy_that_does_not_match_the_approved_hash_leaves_no_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("package.3mf");
        fs::write(&source, b"changed after approval").expect("source");
        let destination = dir.path().join("out/sign.3mf");
        let result = copy_verified(&source, &destination, &sha("the approved bytes"));
        assert!(matches!(result, Err(RevisionError::HashMismatch { .. })));
        assert!(!destination.exists(), "no partial or wrong file at the destination");
        let leftovers = fs::read_dir(dir.path().join("out")).expect("dir").count();
        assert_eq!(leftovers, 0, "the staged copy is removed");
    }

    #[test]
    fn restart_marks_interrupted_builds_failed_and_they_never_finish_later() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = started(claim_build(&mut conn, request("a", None, Actor::Agent)).expect("claim"));
        assert_eq!(reconcile_interrupted(&conn).expect("reconcile"), 1);
        let reloaded = get(&conn, &revision.id).expect("get");
        assert!(matches!(reloaded.build, BuildState::Failed { ref reason, .. } if reason.starts_with("interrupted")));
        assert!(matches!(
            finish_verified(&conn, &revision.id, artifacts(dir.path(), b"late", true), &passed()),
            Err(RevisionError::InvalidTransition { .. })
        ));
    }

    #[test]
    fn print_results_are_recorded_by_people_and_kept_separate_from_slicing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = db();
        let revision = verified(&mut conn, dir.path(), "a");
        assert_eq!(revision.print_validation, PrintValidation::NotTested);
        assert!(matches!(
            record_print_result(&conn, &revision.id, true, "clean", Actor::Agent),
            Err(RevisionError::HumanOnly(_))
        ));
        let tested = record_print_result(&conn, &revision.id, true, "reads correctly", Actor::Human).expect("record");
        assert!(matches!(tested.print_validation, PrintValidation::Passed { .. }));
        assert!(matches!(tested.build, BuildState::Verified { .. }));
    }
}
