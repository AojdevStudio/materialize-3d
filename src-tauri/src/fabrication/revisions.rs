//! Durable record of designs: revisions, the builds they use, and what a
//! person decided about them.
//!
//! Three things are stored apart:
//! 1. A revision is immutable intent: its kind, spec, ancestry, and who asked.
//! 2. A build is immutable artifacts and checks, addressed by `build_key` and
//!    shared by every revision whose spec builds the same way, so a spec that
//!    changes back to an earlier value is a new revision on the earlier build.
//! 3. Human decisions (approval and print validation) are on a revision, and
//!    an approval binds to its build's package hash.
//!
//! Three independent axes are reported on every revision and never collapsed
//! into one status: the build (`BuildState`), the human approval of one exact
//! package hash (`Approval`), and the human-recorded physical print result
//! (`PrintValidation`). A successful slice says nothing about a physical print.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::checks::{CheckId, CheckOutcome, CheckPlanId, PassedChecks};
use super::kind::KindId;

/// Schema 4: one row per sign revision with its build state inline. Kept so a
/// database older than schema 4 still reaches [`MIGRATION_006`] through it.
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

/// Schema 6 (5 is the agent store's): builds move out of revisions.
///
/// Every schema-4 sign revision becomes one revision row and one legacy build
/// row with the same id, its artifacts copied as they are. The old table is
/// dropped rather than renamed, so its `(lineage_id, build_key)` index goes
/// with it. Legacy builds stay out of `builds_live_key`: old rows can share a
/// build key across lineages with different package hashes. Run inside a
/// transaction.
pub const MIGRATION_006: &str = "
CREATE TABLE builds (
    id TEXT PRIMARY KEY,
    build_key TEXT NOT NULL,
    build_status TEXT NOT NULL CHECK (build_status IN ('building', 'verified', 'failed', 'invalid')),
    failure_reason TEXT,
    artifacts_json TEXT,
    check_plan TEXT NOT NULL,
    legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
    owner_session TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO builds (id, build_key, build_status, failure_reason, artifacts_json, check_plan, legacy, created_at, updated_at)
    SELECT id, build_key, build_status, failure_reason, artifacts_json, 'sign-legacy', 1, created_at, updated_at
    FROM sign_revisions;
CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    lineage_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    parent_id TEXT REFERENCES revisions(id),
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    spec_sha256 TEXT NOT NULL,
    build_id TEXT NOT NULL REFERENCES builds(id),
    operation_id TEXT,
    requested_by TEXT NOT NULL CHECK (requested_by IN ('human', 'agent', 'external_mcp')),
    approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'void')),
    approved_package_sha256 TEXT,
    acknowledged_warnings_json TEXT,
    approval_at TEXT,
    void_reason TEXT,
    print_status TEXT NOT NULL DEFAULT 'not_tested' CHECK (print_status IN ('not_tested', 'passed', 'failed')),
    print_note TEXT,
    print_recorded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
INSERT INTO revisions (id, lineage_id, number, parent_id, kind, title, spec_json, spec_sha256, build_id, requested_by,
        approval_status, approved_package_sha256, acknowledged_warnings_json, approval_at, void_reason,
        print_status, print_note, print_recorded_at, created_at, updated_at)
    SELECT id, lineage_id, number, parent_id, 'sign', title, spec_json, spec_sha256, id, requested_by,
        approval_status, approved_sha256, CASE WHEN approval_status = 'approved' THEN '[]' END, approval_at, void_reason,
        print_status, print_note, print_recorded_at, created_at, updated_at
    FROM sign_revisions ORDER BY lineage_id, number;
DROP TABLE sign_revisions;
CREATE UNIQUE INDEX revisions_number ON revisions (lineage_id, number);
CREATE UNIQUE INDEX revisions_operation ON revisions (operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX revisions_build ON revisions (build_id);
CREATE INDEX revisions_kind_created ON revisions (kind, created_at);
CREATE UNIQUE INDEX builds_live_key ON builds (build_key)
    WHERE legacy = 0 AND build_status IN ('building', 'verified');
CREATE TABLE revision_exports (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    format TEXT NOT NULL CHECK (format IN ('print_package', 'included_step')),
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    exported_at TEXT NOT NULL
);
";

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RevisionId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LineageId(String);

/// One build's id. A build converted from a schema-4 revision keeps that
/// revision's id.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BuildId(String);

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
string_newtype!(BuildId);
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
#[cfg_attr(test, derive(ts_rs::TS))]
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
/// `slice.placement_preserved`); the check plan owns the vocabulary.
/// A failed advisory check is a warning, not a failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordedCheck {
    pub id: String,
    pub passed: bool,
    /// Builds recorded before advisory checks existed have none.
    #[serde(default)]
    pub advisory: bool,
    pub detail: String,
}

impl From<&CheckOutcome> for RecordedCheck {
    fn from(outcome: &CheckOutcome) -> Self {
        Self {
            id: outcome.id.to_string(),
            passed: outcome.passed,
            advisory: outcome.id.phase().is_advisory(),
            detail: outcome.detail.clone(),
        }
    }
}

/// The files a finished build produced. Paths are absolute and live inside
/// the build's own directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BuildFiles {
    /// The build's directory. Builds from before builds were separate live in
    /// the directory of the revision that made them.
    pub revision_dir: PathBuf,
    pub package_path: PathBuf,
    pub package_sha256: Sha256Hex,
    pub preview_path: PathBuf,
    pub slice_dir: PathBuf,
    pub gcode_sha256: Sha256Hex,
    pub slicer: SlicerIdentity,
    pub effective_settings: serde_json::Value,
}

/// What a finished build recorded: its files and its checks in plan order.
/// Only [`finish_verified`], which takes the checks from the plan's proof, and
/// [`finish_failed`], which takes the judged outcomes, assemble one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Artifacts {
    #[serde(flatten)]
    files: BuildFiles,
    checks: Vec<RecordedCheck>,
}

impl Artifacts {
    pub fn files(&self) -> &BuildFiles {
        &self.files
    }

    pub fn checks(&self) -> &[RecordedCheck] {
        &self.checks
    }

    /// The failed advisory checks: what a person acknowledges when approving.
    pub fn warnings(&self) -> BTreeSet<&str> {
        self.checks.iter().filter(|c| c.advisory && !c.passed).map(|c| c.id.as_str()).collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BuildState {
    Building,
    Verified { artifacts: Box<Artifacts> },
    Failed { reason: String, artifacts: Option<Box<Artifacts>> },
    /// Was verified, but its package changed or went missing on disk. Every
    /// approval of it is void, nothing can approve it, and the same spec
    /// builds fresh.
    Invalid { reason: String, artifacts: Box<Artifacts> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Approval {
    Pending,
    Approved {
        package_sha256: Sha256Hex,
        /// The warnings the person was shown and accepted with this approval.
        acknowledged_warnings: BTreeSet<CheckId>,
        at: String,
    },
    Void { reason: String, at: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PrintValidation {
    NotTested,
    Passed { at: String, note: String },
    Failed { at: String, note: String },
}

/// One revision of a design, with the state of the build it uses.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Revision {
    pub id: RevisionId,
    pub lineage_id: LineageId,
    pub number: u32,
    pub parent_id: Option<RevisionId>,
    /// The kind every revision of this lineage has, such as `sign`.
    pub kind: String,
    pub title: String,
    /// The spec as it was requested.
    pub spec: serde_json::Value,
    pub spec_sha256: Sha256Hex,
    pub build_id: BuildId,
    pub build_key: Sha256Hex,
    pub requested_by: Actor,
    pub build: BuildState,
    pub approval: Approval,
    pub print_validation: PrintValidation,
    pub created_at: String,
    pub updated_at: String,
}

impl Revision {
    pub fn artifacts(&self) -> Option<&Artifacts> {
        match &self.build {
            BuildState::Verified { artifacts } | BuildState::Invalid { artifacts, .. } => Some(artifacts),
            BuildState::Failed { artifacts, .. } => artifacts.as_deref(),
            BuildState::Building => None,
        }
    }

    /// Building or verified, and not voided: a request for the same spec gets
    /// this revision back instead of a new one.
    fn is_live(&self) -> bool {
        matches!(self.build, BuildState::Building | BuildState::Verified { .. })
            && !matches!(self.approval, Approval::Void { .. })
    }
}

/// What an export wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    /// The approved 3MF package, byte for byte.
    PrintPackage,
}

impl ExportFormat {
    fn as_db(self) -> &'static str {
        match self {
            ExportFormat::PrintPackage => "print_package",
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
    #[error(
        "the acknowledged warnings [{}] are not the build's warnings [{}]",
        .acknowledged.join(", "),
        .recorded.join(", ")
    )]
    WarningsMismatch { recorded: Vec<String>, acknowledged: Vec<String> },
    #[error("approval for revision {0} is void: {1}")]
    ApprovalVoid(String, String),
    #[error("revision {0} cannot be approved: its build is invalid ({1})")]
    BuildInvalid(String, String),
    #[error("revision {0} is not approved")]
    NotApproved(String),
    #[error("design {lineage} is a {kind}; it cannot take a {requested} revision")]
    KindMismatch { lineage: String, kind: String, requested: String },
    #[error("build {build} was planned with check plan {planned}, but its proof is for {proved}")]
    PlanMismatch { build: String, planned: String, proved: &'static str },
    #[error("build {0} has no failed blocking check, so it cannot be recorded as failed")]
    NothingFailed(String),
    #[error("refusing to overwrite existing file {0}")]
    WouldOverwrite(PathBuf),
    #[error("build {id} is {state}, cannot {action}")]
    InvalidTransition { id: String, state: String, action: &'static str },
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

/// A request for a revision of a design.
#[derive(Clone)]
pub struct NewRevision {
    /// `None` starts a new design; `Some` adds a revision to an existing one.
    pub lineage_id: Option<LineageId>,
    pub kind: KindId,
    pub title: String,
    /// The spec as requested; stored as is.
    pub spec: serde_json::Value,
    pub spec_sha256: Sha256Hex,
    /// Hash of every input that determines the output (kind tag, spec,
    /// template, slicer version). Revisions with the same key share a build.
    pub build_key: Sha256Hex,
    /// The plan a new build is checked against; its proof must name it.
    pub check_plan: CheckPlanId,
    pub requested_by: Actor,
}

#[derive(Debug)]
pub enum Claim {
    /// A new revision on a new `building` build. The caller runs the build
    /// and records it with [`finish_verified`] or [`finish_failed`].
    Started(Revision),
    /// Nothing to build. Either the request repeats an existing revision (the
    /// lineage's latest one or, without a lineage, the newest revision anywhere
    /// with this build key), or a new revision now uses a verified build.
    Reused(Revision),
    /// A build with this key is running. Wait until [`build_settled`], then
    /// claim again.
    Busy(BuildId),
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

/// Records a revision for `request`, reusing what already exists. Safe to call
/// repeatedly with the same input.
///
/// A lineage keeps one kind. A request that repeats the lineage's latest
/// revision returns it. Any other request adds a revision, which uses the live
/// build with the same key if there is one, otherwise a verified legacy build
/// with that key, otherwise a new build. A verified build is re-hashed before
/// it is reused; one whose package changed is invalidated and not reused.
pub fn claim(conn: &mut Connection, request: &NewRevision) -> Result<Claim> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let head = match &request.lineage_id {
        Some(lineage) => {
            let head = lineage_head(&tx, lineage)?.ok_or_else(|| RevisionError::NotFound(format!("design {lineage}")))?;
            if head.kind != request.kind.as_str() {
                return Err(RevisionError::KindMismatch {
                    lineage: lineage.to_string(),
                    kind: head.kind,
                    requested: request.kind.to_string(),
                });
            }
            Some(head)
        }
        None => None,
    };

    let repeated = match &head {
        Some(head) => Some(head.clone()).filter(|head| head.build_key == request.build_key && head.is_live()),
        None => newest_live_revision(&tx, &request.build_key)?,
    };
    if let Some(revision) = repeated {
        let reusable = match &revision.build {
            BuildState::Verified { artifacts } => still_intact(&tx, &revision.build_id, artifacts.files())?,
            _ => true,
        };
        if reusable {
            tx.commit()?;
            return Ok(match revision.build {
                BuildState::Building => Claim::Busy(revision.build_id),
                _ => Claim::Reused(revision),
            });
        }
    }

    let (build_id, started) = match reusable_build(&tx, &request.build_key)? {
        Reusable::Running(id) => {
            tx.commit()?;
            return Ok(Claim::Busy(id));
        }
        Reusable::Verified(id) => (id, false),
        Reusable::None => (insert_build(&tx, request)?, true),
    };
    let id = insert_revision(&tx, request, head.as_ref(), &build_id)?;
    let revision = get(&tx, &id)?;
    tx.commit()?;
    Ok(if started { Claim::Started(revision) } else { Claim::Reused(revision) })
}

fn lineage_head(conn: &Connection, lineage: &LineageId) -> Result<Option<Revision>> {
    conn.query_row(&format!("{SELECT} WHERE r.lineage_id = ?1 ORDER BY r.number DESC LIMIT 1"), params![lineage.as_str()], row_to_revision)
        .optional()?
        .transpose()
}

fn newest_live_revision(conn: &Connection, build_key: &Sha256Hex) -> Result<Option<Revision>> {
    let sql = format!(
        "{SELECT} WHERE b.build_key = ?1 AND b.build_status IN ('building', 'verified') AND r.approval_status != 'void'
         ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1"
    );
    conn.query_row(&sql, params![build_key.as_str()], row_to_revision).optional()?.transpose()
}

enum Reusable {
    Running(BuildId),
    Verified(BuildId),
    None,
}

/// The build a new revision with `build_key` can use without building again:
/// the live build with that key, else the newest intact verified legacy build
/// with it. Legacy builds may share a key with different packages, so each
/// candidate whose package changed is invalidated and the next one is tried.
fn reusable_build(conn: &Connection, build_key: &Sha256Hex) -> Result<Reusable> {
    let live: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, build_status, artifacts_json FROM builds
             WHERE build_key = ?1 AND legacy = 0 AND build_status IN ('building', 'verified')",
            params![build_key.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    match live {
        Some((id, status, _)) if status == "building" => return Ok(Reusable::Running(BuildId(id))),
        Some((id, _, artifacts)) => {
            if let Some(id) = intact_build(conn, BuildId(id), artifacts)? {
                return Ok(Reusable::Verified(id));
            }
        }
        None => {}
    }

    let legacy: Vec<(String, Option<String>)> = conn
        .prepare(
            "SELECT id, artifacts_json FROM builds WHERE build_key = ?1 AND legacy = 1 AND build_status = 'verified'
             ORDER BY updated_at DESC, rowid DESC",
        )?
        .query_map(params![build_key.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, artifacts) in legacy {
        if let Some(id) = intact_build(conn, BuildId(id), artifacts)? {
            return Ok(Reusable::Verified(id));
        }
    }
    Ok(Reusable::None)
}

/// `build`, if its stored package still hashes to its record.
fn intact_build(conn: &Connection, build: BuildId, artifacts: Option<String>) -> Result<Option<BuildId>> {
    let artifacts: Artifacts = serde_json::from_str(
        &artifacts.ok_or_else(|| RevisionError::Corrupt(format!("verified build {build} has no artifacts")))?,
    )?;
    Ok(still_intact(conn, &build, artifacts.files())?.then_some(build))
}

/// True when a verified build's package still hashes to its record. A build
/// whose package changed or went missing is invalidated on the spot.
fn still_intact(conn: &Connection, build: &BuildId, files: &BuildFiles) -> Result<bool> {
    match package_change(files)? {
        None => Ok(true),
        Some(reason) => {
            invalidate(conn, build, &reason)?;
            Ok(false)
        }
    }
}

/// Why the package on disk no longer is the one the build recorded, if it is not.
fn package_change(files: &BuildFiles) -> Result<Option<String>> {
    match Sha256Hex::of_file(&files.package_path) {
        Ok(hash) if hash == files.package_sha256 => Ok(None),
        Ok(hash) => Ok(Some(format!("package changed on disk (now {hash})"))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Some("package file is missing".to_owned())),
        Err(err) => Err(err.into()),
    }
}

fn insert_build(conn: &Connection, request: &NewRevision) -> Result<BuildId> {
    let id = BuildId(Uuid::new_v4().to_string());
    let stamp = now();
    conn.execute(
        "INSERT INTO builds (id, build_key, build_status, check_plan, legacy, created_at, updated_at)
         VALUES (?1, ?2, 'building', ?3, 0, ?4, ?4)",
        params![id.as_str(), request.build_key.as_str(), request.check_plan.as_str(), stamp],
    )?;
    Ok(id)
}

fn insert_revision(conn: &Connection, request: &NewRevision, head: Option<&Revision>, build: &BuildId) -> Result<RevisionId> {
    let lineage = head.map_or_else(LineageId::new, |head| head.lineage_id.clone());
    let id = RevisionId(Uuid::new_v4().to_string());
    let stamp = now();
    conn.execute(
        "INSERT INTO revisions (id, lineage_id, number, parent_id, kind, title, spec_json, spec_sha256, build_id,
             requested_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id.as_str(),
            lineage.as_str(),
            head.map_or(1, |head| head.number + 1),
            head.map(|head| head.id.as_str()),
            request.kind.as_str(),
            request.title,
            serde_json::to_string(&request.spec)?,
            request.spec_sha256.as_str(),
            build.as_str(),
            request.requested_by.as_db(),
            stamp,
        ],
    )?;
    Ok(id)
}

/// Records a build whose every planned blocking check passed. Only a check
/// plan makes a [`PassedChecks`], so this is the one way a build becomes
/// `Verified`, and its recorded checks are the proof's outcomes, warnings
/// included. The proof must be for the plan the build was claimed with.
///
/// ```
/// use materialize_3d_lib::fabrication::checks::PassedChecks;
/// use materialize_3d_lib::fabrication::revisions::{self, BuildFiles, BuildId, Result};
/// fn record(conn: &rusqlite::Connection, build: &BuildId, files: BuildFiles, passed: &PassedChecks) -> Result<()> {
///     revisions::finish_verified(conn, build, files, passed)
/// }
/// ```
///
/// A plain list of passing checks is not proof and does not compile:
///
/// ```compile_fail,E0308
/// use materialize_3d_lib::fabrication::revisions::{self, BuildFiles, BuildId, RecordedCheck, Result};
/// fn record(conn: &rusqlite::Connection, build: &BuildId, files: BuildFiles, checks: Vec<RecordedCheck>) -> Result<()> {
///     revisions::finish_verified(conn, build, files, checks)
/// }
/// ```
pub fn finish_verified(conn: &Connection, build: &BuildId, files: BuildFiles, passed: &PassedChecks) -> Result<()> {
    let checks = passed.outcomes().iter().map(RecordedCheck::from).collect();
    let artifacts = serde_json::to_string(&Artifacts { files, checks })?;
    let changed = conn.execute(
        "UPDATE builds SET build_status = 'verified', artifacts_json = ?2, updated_at = ?3
         WHERE id = ?1 AND build_status = 'building' AND check_plan = ?4",
        params![build.as_str(), artifacts, now(), passed.plan().as_str()],
    )?;
    if changed == 1 {
        return Ok(());
    }
    let (status, planned) = build_row(conn, build)?;
    if status == "building" {
        return Err(RevisionError::PlanMismatch { build: build.to_string(), planned, proved: passed.plan().as_str() });
    }
    Err(RevisionError::InvalidTransition { id: build.to_string(), state: status, action: "finish" })
}

/// Records a build whose checks ran and at least one blocking check failed,
/// keeping every outcome as evidence. Failed advisory checks alone are
/// warnings, not a failure, and are refused here.
pub fn finish_failed(conn: &Connection, build: &BuildId, files: BuildFiles, outcomes: &[CheckOutcome]) -> Result<()> {
    let failed: Vec<&str> = outcomes
        .iter()
        .filter(|o| !o.passed && !o.id.phase().is_advisory())
        .map(|o| o.id.as_str())
        .collect();
    if failed.is_empty() {
        return Err(RevisionError::NothingFailed(build.to_string()));
    }
    let checks = outcomes.iter().map(RecordedCheck::from).collect();
    let artifacts = serde_json::to_string(&Artifacts { files, checks })?;
    let changed = conn.execute(
        "UPDATE builds SET build_status = 'failed', failure_reason = ?2, artifacts_json = ?3, updated_at = ?4
         WHERE id = ?1 AND build_status = 'building'",
        params![build.as_str(), format!("checks failed: {}", failed.join(", ")), artifacts, now()],
    )?;
    ensure_transition(conn, build, changed, "fail")
}

/// Records a build that stopped before its checks were judged.
pub fn fail_build(conn: &Connection, build: &BuildId, reason: &str) -> Result<()> {
    let changed = conn.execute(
        "UPDATE builds SET build_status = 'failed', failure_reason = ?2, updated_at = ?3
         WHERE id = ?1 AND build_status = 'building'",
        params![build.as_str(), reason, now()],
    )?;
    ensure_transition(conn, build, changed, "fail")
}

/// True once a build is no longer running.
pub fn build_settled(conn: &Connection, build: &BuildId) -> Result<bool> {
    Ok(build_row(conn, build)?.0 != "building")
}

/// Builds still recorded as running. At startup these are builds the app
/// stopped in the middle of; none of them has artifacts on record.
pub fn unfinished_builds(conn: &Connection) -> Result<Vec<BuildId>> {
    let mut stmt = conn.prepare("SELECT id FROM builds WHERE build_status = 'building'")?;
    let ids = stmt.query_map([], |row| row.get::<_, String>(0).map(BuildId))?;
    Ok(ids.collect::<rusqlite::Result<_>>()?)
}

/// Marks builds left running by a crash or quit as failed. Run once at startup
/// before anything can claim new builds. Returns how many builds changed.
pub fn reconcile_interrupted(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE builds SET build_status = 'failed',
             failure_reason = 'interrupted: the app stopped before this build finished', updated_at = ?1
         WHERE build_status = 'building'",
        params![now()],
    )?)
}

/// Approves exactly the package the person reviewed, with exactly the warnings
/// they were shown. `expected` is the hash the UI displayed and the file on
/// disk must still match it; `acknowledged` must equal the build's warnings.
/// Both are checked in the transaction that records the approval.
pub fn approve(
    conn: &mut Connection,
    id: &RevisionId,
    expected: &Sha256Hex,
    acknowledged: &BTreeSet<CheckId>,
    actor: Actor,
) -> Result<Revision> {
    if actor != Actor::Human {
        return Err(RevisionError::HumanOnly("approve a revision"));
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let revision = get(&tx, id)?;
    let artifacts = match &revision.build {
        BuildState::Verified { artifacts } => artifacts,
        BuildState::Failed { .. } => return Err(RevisionError::ChecksFailed(id.to_string())),
        BuildState::Building => return Err(RevisionError::NotVerified(id.to_string())),
        BuildState::Invalid { reason, .. } => return Err(RevisionError::BuildInvalid(id.to_string(), reason.clone())),
    };
    let files = artifacts.files();
    if &files.package_sha256 != expected {
        return Err(RevisionError::HashMismatch {
            expected: expected.to_string(),
            actual: files.package_sha256.to_string(),
        });
    }
    let recorded = artifacts.warnings();
    if recorded != acknowledged.iter().map(CheckId::as_str).collect() {
        return Err(RevisionError::WarningsMismatch {
            recorded: recorded.into_iter().map(str::to_owned).collect(),
            acknowledged: acknowledged.iter().map(CheckId::to_string).collect(),
        });
    }
    if let Some(change) = package_change(files)? {
        let reason = format!("{change} before approval");
        invalidate(&tx, &revision.build_id, &reason)?;
        tx.commit()?;
        return Err(RevisionError::BuildInvalid(id.to_string(), reason));
    }
    match &revision.approval {
        Approval::Approved { package_sha256, .. } if package_sha256 == expected => return Ok(revision),
        Approval::Approved { .. } => return Err(RevisionError::Corrupt(format!("{id} approved for another hash"))),
        Approval::Void { reason, .. } => return Err(RevisionError::ApprovalVoid(id.to_string(), reason.clone())),
        Approval::Pending => {}
    }
    tx.execute(
        "UPDATE revisions SET approval_status = 'approved', approved_package_sha256 = ?2,
             acknowledged_warnings_json = ?3, approval_at = ?4, updated_at = ?4
         WHERE id = ?1 AND approval_status = 'pending'",
        params![id.as_str(), expected.as_str(), serde_json::to_string(acknowledged)?, now()],
    )?;
    let approved = get(&tx, id)?;
    tx.commit()?;
    Ok(approved)
}

/// Re-hashes an approved revision's package. A changed or missing file
/// invalidates the build and voids every approval of it, permanently; the
/// same spec then builds fresh and needs a fresh approval.
pub fn check_integrity(conn: &mut Connection, id: &RevisionId) -> Result<Revision> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let revision = get(&tx, id)?;
    let change = match (&revision.approval, &revision.build) {
        (Approval::Approved { .. }, BuildState::Verified { artifacts }) => package_change(artifacts.files())?,
        _ => None,
    };
    let Some(reason) = change else {
        return Ok(revision);
    };
    invalidate(&tx, &revision.build_id, &format!("{reason} after approval"))?;
    let voided = get(&tx, id)?;
    tx.commit()?;
    Ok(voided)
}

/// Marks a verified build invalid and voids every approval a person gave a
/// revision that uses it. A revision nobody approved stays pending, so no
/// record claims a decision that was never made; its invalid build already
/// keeps it from being approved. Callers run it inside their transaction.
fn invalidate(conn: &Connection, build: &BuildId, reason: &str) -> Result<()> {
    let stamp = now();
    conn.execute(
        "UPDATE builds SET build_status = 'invalid', failure_reason = ?2, updated_at = ?3
         WHERE id = ?1 AND build_status = 'verified'",
        params![build.as_str(), reason, stamp],
    )?;
    conn.execute(
        "UPDATE revisions SET approval_status = 'void', void_reason = ?2, approval_at = ?3, updated_at = ?3
         WHERE build_id = ?1 AND approval_status = 'approved'",
        params![build.as_str(), reason, stamp],
    )?;
    Ok(())
}

/// Copies an approved package to `destination` and records the export.
/// Never overwrites.
pub fn export(conn: &mut Connection, id: &RevisionId, format: ExportFormat, destination: &Path) -> Result<PathBuf> {
    let revision = check_integrity(conn, id)?;
    let approved = match &revision.approval {
        Approval::Approved { package_sha256, .. } => package_sha256.clone(),
        Approval::Void { reason, .. } => return Err(RevisionError::ApprovalVoid(id.to_string(), reason.clone())),
        Approval::Pending => return Err(RevisionError::NotApproved(id.to_string())),
    };
    // Every format so far copies the approved package itself; a format that
    // extracts a member from it adds an arm here.
    let ExportFormat::PrintPackage = format;
    let artifacts = revision.artifacts().ok_or_else(|| RevisionError::NotVerified(id.to_string()))?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    match copy_verified(&artifacts.files().package_path, destination, &approved) {
        Ok(written) => {
            tx.execute(
                "INSERT INTO revision_exports (id, revision_id, format, path, sha256, exported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    Uuid::new_v4().to_string(),
                    id.as_str(),
                    format.as_db(),
                    written.to_string_lossy(),
                    approved.as_str(),
                    now(),
                ],
            )?;
            tx.commit()?;
            Ok(written)
        }
        Err(RevisionError::HashMismatch { expected, actual }) => {
            invalidate(&tx, &revision.build_id, &format!("package changed during export (now {actual})"))?;
            tx.commit()?;
            Err(RevisionError::HashMismatch { expected, actual })
        }
        Err(other) => Err(other),
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

/// Records what happened when the design was physically printed. Person only.
pub fn record_print_result(conn: &Connection, id: &RevisionId, passed: bool, note: &str, actor: Actor) -> Result<Revision> {
    if actor != Actor::Human {
        return Err(RevisionError::HumanOnly("record a physical print result"));
    }
    let revision = get(conn, id)?;
    if !matches!(revision.build, BuildState::Verified { .. }) {
        return Err(RevisionError::NotVerified(id.to_string()));
    }
    conn.execute(
        "UPDATE revisions SET print_status = ?2, print_note = ?3, print_recorded_at = ?4, updated_at = ?4 WHERE id = ?1",
        params![id.as_str(), if passed { "passed" } else { "failed" }, note, now()],
    )?;
    get(conn, id)
}

pub fn get(conn: &Connection, id: &RevisionId) -> Result<Revision> {
    conn.query_row(&format!("{SELECT} WHERE r.id = ?1"), params![id.as_str()], row_to_revision)
        .optional()?
        .ok_or_else(|| RevisionError::NotFound(id.to_string()))?
}

pub fn list_lineage(conn: &Connection, lineage: &LineageId) -> Result<Vec<Revision>> {
    let mut stmt = conn.prepare(&format!("{SELECT} WHERE r.lineage_id = ?1 ORDER BY r.number DESC"))?;
    let rows = stmt.query_map(params![lineage.as_str()], row_to_revision)?;
    rows.map(|row| row?).collect()
}

pub fn list_recent(conn: &Connection, limit: u32) -> Result<Vec<Revision>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?1"))?;
    let rows = stmt.query_map(params![limit], row_to_revision)?;
    rows.map(|row| row?).collect()
}

/// A build's status and the check plan it was claimed with.
fn build_row(conn: &Connection, build: &BuildId) -> Result<(String, String)> {
    conn.query_row("SELECT build_status, check_plan FROM builds WHERE id = ?1", params![build.as_str()], |row| {
        Ok((row.get(0)?, row.get(1)?))
    })
    .optional()?
    .ok_or_else(|| RevisionError::NotFound(format!("build {build}")))
}

fn ensure_transition(conn: &Connection, build: &BuildId, changed: usize, action: &'static str) -> Result<()> {
    if changed == 1 {
        return Ok(());
    }
    Err(RevisionError::InvalidTransition { id: build.to_string(), state: build_row(conn, build)?.0, action })
}

const SELECT: &str = "SELECT r.id, r.lineage_id, r.number, r.parent_id, r.kind, r.title, r.spec_json, r.spec_sha256,
    r.build_id, b.build_key, r.requested_by, b.build_status, b.failure_reason, b.artifacts_json, r.approval_status,
    r.approved_package_sha256, r.acknowledged_warnings_json, r.approval_at, r.void_reason, r.print_status,
    r.print_note, r.print_recorded_at, r.created_at, r.updated_at
    FROM revisions r JOIN builds b ON b.id = r.build_id";

/// Parses one row into the typed model. The outer `rusqlite::Result` carries
/// column access errors; the inner one carries domain-level corruption.
fn row_to_revision(row: &Row<'_>) -> rusqlite::Result<Result<Revision>> {
    let text = |index: usize| row.get::<_, String>(index);
    let optional = |index: usize| row.get::<_, Option<String>>(index);
    let (id, lineage, number, parent) = (text(0)?, text(1)?, row.get::<_, u32>(2)?, optional(3)?);
    let (kind, title, spec_json, spec_sha) = (text(4)?, text(5)?, text(6)?, text(7)?);
    let (build_id, build_key, requested_by) = (text(8)?, text(9)?, text(10)?);
    let (build_status, failure_reason, artifacts_json) = (text(11)?, optional(12)?, optional(13)?);
    let (approval_status, approved_sha, acknowledged, approval_at, void_reason) =
        (text(14)?, optional(15)?, optional(16)?, optional(17)?, optional(18)?);
    let (print_status, print_note, print_at) = (text(19)?, optional(20)?, optional(21)?);
    let (created_at, updated_at) = (text(22)?, text(23)?);

    Ok((|| {
        let artifacts = artifacts_json
            .map(|json| serde_json::from_str::<Artifacts>(&json).map(Box::new))
            .transpose()?;
        let build = match (build_status.as_str(), artifacts) {
            ("building", _) => BuildState::Building,
            ("verified", Some(artifacts)) => BuildState::Verified { artifacts },
            ("failed", artifacts) => BuildState::Failed { reason: failure_reason.unwrap_or_default(), artifacts },
            ("invalid", Some(artifacts)) => BuildState::Invalid { reason: failure_reason.unwrap_or_default(), artifacts },
            (other, _) => return Err(RevisionError::Corrupt(format!("{id} build_status {other}"))),
        };
        let approval = match (approval_status.as_str(), approved_sha, acknowledged, approval_at) {
            ("pending", ..) => Approval::Pending,
            ("approved", Some(sha), Some(acknowledged), Some(at)) => Approval::Approved {
                package_sha256: Sha256Hex::try_from(sha)?,
                acknowledged_warnings: serde_json::from_str(&acknowledged)?,
                at,
            },
            ("void", _, _, at) => Approval::Void { reason: void_reason.unwrap_or_default(), at: at.unwrap_or_default() },
            (other, ..) => return Err(RevisionError::Corrupt(format!("{id} approval_status {other}"))),
        };
        let print_validation = match print_status.as_str() {
            "not_tested" => PrintValidation::NotTested,
            "passed" => PrintValidation::Passed { at: print_at.unwrap_or_default(), note: print_note.unwrap_or_default() },
            "failed" => PrintValidation::Failed { at: print_at.unwrap_or_default(), note: print_note.unwrap_or_default() },
            other => return Err(RevisionError::Corrupt(format!("{id} print_status {other}"))),
        };
        Ok(Revision {
            id: RevisionId(id),
            lineage_id: LineageId(lineage),
            number,
            parent_id: parent.map(RevisionId),
            kind,
            title,
            spec: serde_json::from_str(&spec_json)?,
            spec_sha256: Sha256Hex::try_from(spec_sha)?,
            build_id: BuildId(build_id),
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
mod tests;
