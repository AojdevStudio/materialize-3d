use serde_json::json;

use super::*;
use crate::fabrication::bambu::CheckId as SliceCheck;
use crate::fabrication::checks::{slice_check_id, test_support, CheckPhase};

/// A database at schema 4 migrated to schema 6, the way an upgrade runs it.
fn db() -> Connection {
    let mut conn = Connection::open_in_memory().expect("in-memory db");
    conn.execute_batch(MIGRATION_004).expect("migration 004");
    migrate_to_6(&mut conn);
    conn
}

fn migrate_to_6(conn: &mut Connection) {
    let tx = conn.transaction().expect("tx");
    tx.execute_batch(MIGRATION_006).expect("migration 006");
    tx.commit().expect("commit");
}

fn sha(seed: &str) -> Sha256Hex {
    Sha256Hex::of_bytes(seed.as_bytes())
}

fn request(key: &str, lineage: Option<LineageId>, actor: Actor) -> NewRevision {
    NewRevision {
        lineage_id: lineage,
        kind: KindId::new("sign"),
        title: "Back shortly".into(),
        spec: json!({ "width_mm": key }),
        spec_sha256: sha(key),
        build_key: sha(key),
        check_plan: test_support::PLAN,
        requested_by: actor,
    }
}

fn started(claim: Claim) -> Revision {
    match claim {
        Claim::Started(revision) => revision,
        other => panic!("expected a new build, got {other:?}"),
    }
}

fn reused(claim: Claim) -> Revision {
    match claim {
        Claim::Reused(revision) => revision,
        other => panic!("expected a reused build, got {other:?}"),
    }
}

/// The files of a build whose package holds `contents`.
fn files(dir: &Path, contents: &[u8]) -> BuildFiles {
    let package_path = dir.join(format!("{}.3mf", Sha256Hex::of_bytes(contents)));
    fs::write(&package_path, contents).expect("write package");
    BuildFiles {
        revision_dir: dir.to_path_buf(),
        package_sha256: Sha256Hex::of_bytes(contents),
        package_path,
        preview_path: dir.join("preview.png"),
        slice_dir: dir.join("slice"),
        gcode_sha256: sha("gcode"),
        slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "02.08.00.05".into() },
        effective_settings: json!({}),
    }
}

fn slice_checks() -> [CheckId; 2] {
    [slice_check_id(SliceCheck::SliceSucceeded), slice_check_id(SliceCheck::PlacementPreserved)]
}

/// Proof that both slice checks passed.
fn passed() -> PassedChecks {
    test_support::passed(&slice_checks())
}

/// Judged outcomes of the two slice checks, the second as `placement_passes`.
fn outcomes(placement_passes: bool) -> Vec<CheckOutcome> {
    let [succeeded, placement] = slice_checks();
    vec![
        CheckOutcome { id: succeeded, passed: true, detail: "return_code 0".into() },
        CheckOutcome { id: placement, passed: placement_passes, detail: "max deviation".into() },
    ]
}

fn finish(conn: &Connection, revision: &Revision, dir: &Path) -> Revision {
    finish_verified(conn, &revision.build_id, files(dir, revision.build_key.as_str().as_bytes()), &passed()).expect("finish");
    get(conn, &revision.id).expect("get")
}

/// A verified revision of a new design.
fn verified(conn: &mut Connection, dir: &Path, key: &str) -> Revision {
    let revision = started(claim(conn, &request(key, None, Actor::Agent)).expect("claim"));
    finish(conn, &revision, dir)
}

fn package_hash(revision: &Revision) -> Sha256Hex {
    revision.artifacts().expect("artifacts").files().package_sha256.clone()
}

fn none() -> BTreeSet<CheckId> {
    BTreeSet::new()
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0)).expect("count")
}

#[test]
fn a_repeated_request_returns_the_revision_or_waits_for_its_build() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let first = started(claim(&mut conn, &request("a", None, Actor::Agent)).expect("claim"));
    match claim(&mut conn, &request("a", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim") {
        Claim::Busy(build) => assert_eq!(build, first.build_id, "a running build is waited on"),
        other => panic!("expected to wait, got {other:?}"),
    }
    let first = finish(&conn, &first, dir.path());
    let again = reused(claim(&mut conn, &request("a", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
    assert_eq!(again.id, first.id, "the lineage's latest revision is returned, not copied");
    let anywhere = reused(claim(&mut conn, &request("a", None, Actor::Human)).expect("claim"));
    assert_eq!(anywhere.id, first.id, "a retry without a lineage finds it too");
    assert_eq!(count(&conn, "revisions"), 1);
}

/// 60 -> 65 -> 60: the third request is revision 3, on revision 1's build.
#[test]
fn returning_to_an_earlier_spec_is_a_new_revision_on_the_earlier_build() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let first = verified(&mut conn, dir.path(), "60");
    let second = started(claim(&mut conn, &request("65", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
    let second = finish(&conn, &second, dir.path());

    let third = reused(claim(&mut conn, &request("60", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
    assert_eq!((third.number, third.parent_id.as_ref()), (3, Some(&second.id)));
    assert_eq!(third.build_id, first.build_id, "revision 3 uses revision 1's build");
    assert!(matches!(third.build, BuildState::Verified { .. }), "nothing to build");
    assert_eq!(third.approval, Approval::Pending, "a new revision needs its own approval");
    assert_eq!(count(&conn, "builds"), 2, "60 was built once");
    let numbers: Vec<u32> = list_lineage(&conn, &first.lineage_id).expect("lineage").iter().map(|r| r.number).collect();
    assert_eq!(numbers, [3, 2, 1]);
}

#[test]
fn a_lineage_refuses_a_second_kind() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let sign = verified(&mut conn, dir.path(), "a");
    let mut part = request("b", Some(sign.lineage_id.clone()), Actor::Agent);
    part.kind = KindId::new("part");
    let err = claim(&mut conn, &part).expect_err("refused");
    assert!(matches!(&err, RevisionError::KindMismatch { kind, requested, .. } if kind == "sign" && requested == "part"), "{err}");
    assert_eq!((count(&conn, "revisions"), count(&conn, "builds")), (1, 1), "nothing recorded");
    assert_eq!(sign.kind, "sign");
}

#[test]
fn a_failed_build_can_be_retried_as_a_new_revision() {
    let mut conn = db();
    let first = started(claim(&mut conn, &request("a", None, Actor::Agent)).expect("claim"));
    fail_build(&conn, &first.build_id, "slicer crashed").expect("fail");
    let retry = started(claim(&mut conn, &request("a", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
    assert_eq!(retry.number, 2);
    assert_eq!(retry.parent_id.as_ref(), Some(&first.id));
    assert_ne!(retry.build_id, first.build_id, "a failed build is never reused");
}

#[test]
fn a_changed_spec_starts_a_new_pending_revision_in_the_same_design() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let first = verified(&mut conn, dir.path(), "a");
    approve(&mut conn, &first.id, &package_hash(&first), &none(), Actor::Human).expect("approve");
    let second = started(claim(&mut conn, &request("b", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
    assert_eq!(second.number, 2);
    assert_eq!(second.approval, Approval::Pending);
}

#[test]
fn only_a_person_can_approve_and_only_the_reviewed_hash() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let revision = verified(&mut conn, dir.path(), "a");
    let hash = package_hash(&revision);
    for actor in [Actor::Agent, Actor::ExternalMcp] {
        assert!(matches!(approve(&mut conn, &revision.id, &hash, &none(), actor), Err(RevisionError::HumanOnly(_))));
    }
    assert!(matches!(approve(&mut conn, &revision.id, &sha("other"), &none(), Actor::Human), Err(RevisionError::HashMismatch { .. })));
    let approved = approve(&mut conn, &revision.id, &hash, &none(), Actor::Human).expect("approve");
    assert!(matches!(approved.approval, Approval::Approved { ref package_sha256, ref acknowledged_warnings, .. }
        if *package_sha256 == hash && acknowledged_warnings.is_empty()));
}

/// A build verified with a warning can be approved only by acknowledging
/// exactly that warning.
#[test]
fn approval_must_acknowledge_exactly_the_builds_warnings() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let overhang = CheckId::new(CheckPhase::Print, "overhang.white");
    let ids = [slice_checks().to_vec(), vec![overhang.clone()]].concat();
    let revision = started(claim(&mut conn, &request("a", None, Actor::Agent)).expect("claim"));
    let proof = test_support::with_warnings(&ids, std::slice::from_ref(&overhang));
    finish_verified(&conn, &revision.build_id, files(dir.path(), b"pkg"), &proof).expect("a warning still verifies");
    let revision = get(&conn, &revision.id).expect("get");
    let artifacts = revision.artifacts().expect("artifacts");
    assert!(matches!(revision.build, BuildState::Verified { .. }));
    assert_eq!(artifacts.warnings(), BTreeSet::from([overhang.as_str()]));
    let recorded = artifacts.checks().iter().find(|c| c.id == overhang.as_str()).expect("recorded");
    assert!(recorded.advisory && !recorded.passed);

    let hash = package_hash(&revision);
    let other = CheckId::new(CheckPhase::Print, "overhang.navy");
    for wrong in [none(), BTreeSet::from([other.clone()]), BTreeSet::from([overhang.clone(), other])] {
        let refused = approve(&mut conn, &revision.id, &hash, &wrong, Actor::Human);
        assert!(matches!(refused, Err(RevisionError::WarningsMismatch { .. })), "{wrong:?}: {refused:?}");
    }
    assert_eq!(get(&conn, &revision.id).expect("get").approval, Approval::Pending, "a refused approval records nothing");

    let exact = BTreeSet::from([overhang]);
    let approved = approve(&mut conn, &revision.id, &hash, &exact, Actor::Human).expect("approve");
    assert!(matches!(approved.approval, Approval::Approved { ref acknowledged_warnings, .. } if *acknowledged_warnings == exact));
}

#[test]
fn a_verified_build_records_exactly_its_proofs_checks() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let revision = verified(&mut conn, dir.path(), "a");
    let ids: Vec<&str> = revision.artifacts().expect("artifacts").checks().iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, ["slice.slice_succeeded", "slice.placement_preserved"]);
}

#[test]
fn a_build_fails_only_on_a_failed_blocking_check() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let revision = started(claim(&mut conn, &request("a", None, Actor::Agent)).expect("claim"));
    let warning_only = [outcomes(true), vec![CheckOutcome {
        id: CheckId::new(CheckPhase::Print, "overhang.white"),
        passed: false,
        detail: "62 degrees".into(),
    }]]
    .concat();
    let refused = finish_failed(&conn, &revision.build_id, files(dir.path(), b"pkg"), &warning_only);
    assert!(matches!(refused, Err(RevisionError::NothingFailed(_))), "{refused:?}");
    assert!(matches!(get(&conn, &revision.id).expect("get").build, BuildState::Building), "still running");

    finish_failed(&conn, &revision.build_id, files(dir.path(), b"pkg"), &outcomes(false)).expect("fail");
    let failed = get(&conn, &revision.id).expect("get");
    assert!(matches!(failed.build, BuildState::Failed { ref reason, .. } if reason == "checks failed: slice.placement_preserved"));
    let hash = package_hash(&failed);
    assert!(matches!(approve(&mut conn, &revision.id, &hash, &none(), Actor::Human), Err(RevisionError::ChecksFailed(_))));
}

/// A failed declared measurement (`geometry.requirement.<n>`) fails the build
/// even when the only other failure is a warning.
#[test]
fn a_failed_requirement_fails_the_build_beside_a_warning() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let revision = started(claim(&mut conn, &request("a", None, Actor::Agent)).expect("claim"));
    let requirement = CheckId::try_from("geometry.requirement.0".to_owned()).expect("check id");
    let judged = [
        outcomes(true),
        vec![
            CheckOutcome { id: requirement, passed: false, detail: "opening 11.2 mm, want 12.0 ± 0.2".into() },
            CheckOutcome { id: CheckId::new(CheckPhase::Print, "overhang.white"), passed: false, detail: "62 degrees".into() },
        ],
    ]
    .concat();
    finish_failed(&conn, &revision.build_id, files(dir.path(), b"pkg"), &judged).expect("a failed requirement fails the build");
    let failed = get(&conn, &revision.id).expect("get");
    assert!(matches!(failed.build, BuildState::Failed { ref reason, .. } if reason == "checks failed: geometry.requirement.0"));
    assert_eq!(failed.artifacts().expect("artifacts").warnings(), BTreeSet::from(["print.overhang.white"]), "the warning is kept beside it");
}

#[test]
fn a_proof_for_another_plan_cannot_verify_a_build() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let mut planned = request("a", None, Actor::Agent);
    planned.check_plan = CheckPlanId::new("sign-checks-1");
    let revision = started(claim(&mut conn, &planned).expect("claim"));
    let err = finish_verified(&conn, &revision.build_id, files(dir.path(), b"pkg"), &passed()).expect_err("refused");
    assert!(matches!(&err, RevisionError::PlanMismatch { planned, proved, .. } if planned == "sign-checks-1" && *proved == "test-support-1"), "{err}");
}

#[test]
fn changing_the_file_after_approval_invalidates_the_build_and_blocks_export() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let revision = verified(&mut conn, dir.path(), "a");
    let artifacts = revision.artifacts().expect("artifacts").clone();
    approve(&mut conn, &revision.id, &package_hash(&revision), &none(), Actor::Human).expect("approve");
    fs::write(&artifacts.files().package_path, b"tampered").expect("tamper");
    let checked = check_integrity(&mut conn, &revision.id).expect("integrity");
    assert!(matches!(checked.approval, Approval::Void { .. }));
    assert!(matches!(checked.build, BuildState::Invalid { ref reason, .. } if reason.starts_with("package changed on disk")));
    let target = dir.path().join("out/sign.3mf");
    assert!(matches!(export(&mut conn, &revision.id, ExportFormat::PrintPackage, &target), Err(RevisionError::ApprovalVoid(..))));
    assert!(!target.exists());
}

#[test]
/// Invalidating a build voids the approval a person gave, and only that: a
/// revision on the same build that nobody approved stays pending, with no
/// approval time, and cannot be approved because its build is invalid.
#[test]
fn an_invalid_build_voids_its_approvals_and_leaves_pending_revisions_pending() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let first = verified(&mut conn, dir.path(), "60");
    let second = started(claim(&mut conn, &request("65", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
    finish(&conn, &second, dir.path());
    let third = reused(claim(&mut conn, &request("60", Some(first.lineage_id.clone()), Actor::Agent)).expect("claim"));
    approve(&mut conn, &third.id, &package_hash(&third), &none(), Actor::Human).expect("approve");

    fs::remove_file(&first.artifacts().expect("artifacts").files().package_path).expect("package lost");
    check_integrity(&mut conn, &third.id).expect("integrity");
    let approved = get(&conn, &third.id).expect("get");
    assert!(matches!(approved.approval, Approval::Void { ref reason, .. } if reason == "package file is missing after approval"));
    assert!(matches!(approved.build, BuildState::Invalid { .. }));

    let pending = get(&conn, &first.id).expect("get");
    assert!(matches!(pending.build, BuildState::Invalid { .. }), "it shares the invalid build");
    assert_eq!(pending.approval, Approval::Pending, "nobody approved it, so nothing is voided");
    let approval_at: Option<String> = conn
        .query_row("SELECT approval_at FROM revisions WHERE id = ?1", [first.id.as_str()], |row| row.get(0))
        .expect("approval_at");
    assert_eq!(approval_at, None, "no approval time for a decision nobody made");
    let refused = approve(&mut conn, &first.id, &package_hash(&first), &none(), Actor::Human);
    assert!(matches!(refused, Err(RevisionError::BuildInvalid(..))), "{refused:?}");
    assert_eq!(get(&conn, &first.id).expect("get").approval, Approval::Pending);

    assert_eq!(get(&conn, &second.id).expect("get").approval, Approval::Pending, "another build's revision is untouched");
}

#[test]
fn export_requires_approval_never_overwrites_and_is_recorded() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let revision = verified(&mut conn, dir.path(), "a");
    let target = dir.path().join("out/sign.3mf");
    assert!(matches!(export(&mut conn, &revision.id, ExportFormat::PrintPackage, &target), Err(RevisionError::NotApproved(_))));
    let hash = package_hash(&revision);
    approve(&mut conn, &revision.id, &hash, &none(), Actor::Human).expect("approve");
    export(&mut conn, &revision.id, ExportFormat::PrintPackage, &target).expect("export");
    assert_eq!(Sha256Hex::of_file(&target).expect("hash"), hash);
    assert!(matches!(export(&mut conn, &revision.id, ExportFormat::PrintPackage, &target), Err(RevisionError::WouldOverwrite(_))));

    let recorded: Vec<(String, String, String, String)> = conn
        .prepare("SELECT revision_id, format, path, sha256 FROM revision_exports")
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .expect("query")
        .collect::<rusqlite::Result<_>>()
        .expect("rows");
    let path = target.to_string_lossy().into_owned();
    assert_eq!(recorded, [(revision.id.to_string(), "print_package".to_owned(), path, hash.to_string())], "one record per file written");
}

/// `builds_live_key` leaves out invalid builds, so the same spec builds again.
#[test]
fn a_void_approval_does_not_block_rebuilding_the_same_spec() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = db();
    let revision = verified(&mut conn, dir.path(), "a");
    approve(&mut conn, &revision.id, &package_hash(&revision), &none(), Actor::Human).expect("approve");
    fs::remove_file(&revision.artifacts().expect("artifacts").files().package_path).expect("package lost");
    assert!(matches!(check_integrity(&mut conn, &revision.id).expect("integrity").approval, Approval::Void { .. }));
    let rebuilt = started(claim(&mut conn, &request("a", Some(revision.lineage_id.clone()), Actor::Agent)).expect("claim"));
    assert_eq!(rebuilt.number, 2);
    assert_eq!(rebuilt.approval, Approval::Pending);
    assert_ne!(rebuilt.build_id, revision.build_id, "a fresh build, not the invalid one");
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
    let revision = started(claim(&mut conn, &request("a", None, Actor::Agent)).expect("claim"));
    assert_eq!(unfinished_builds(&conn).expect("unfinished"), [revision.build_id.clone()]);
    assert_eq!(reconcile_interrupted(&conn).expect("reconcile"), 1);
    let reloaded = get(&conn, &revision.id).expect("get");
    assert!(matches!(reloaded.build, BuildState::Failed { ref reason, .. } if reason.starts_with("interrupted")));
    assert!(matches!(
        finish_verified(&conn, &revision.build_id, files(dir.path(), b"late"), &passed()),
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

/// Schema-4 sign revisions, as the app stored them before builds were separate.
mod legacy {
    use super::*;

    /// Inserts a schema-4 revision row; `artifacts` is its stored JSON.
    fn insert(conn: &Connection, id: &str, lineage: &str, number: u32, build_key: &Sha256Hex, status: &str, approval: &str, artifacts: Option<String>) {
        let parent = (number > 1).then(|| format!("{lineage}-{}", number - 1));
        conn.execute(
            "INSERT INTO sign_revisions (id, lineage_id, number, parent_id, title, spec_json, spec_sha256, build_key,
                 requested_by, build_status, artifacts_json, approval_status, approved_sha256, approval_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'Legacy', '{}', ?5, ?5, 'agent', ?6, ?7, ?8,
                 CASE WHEN ?8 = 'approved' THEN ?9 END, CASE WHEN ?8 != 'pending' THEN '2026-09-30T10:00:00Z' END,
                 '2026-09-30T09:00:00Z', '2026-09-30T09:00:00Z')",
            params![id, lineage, number, parent, build_key.as_str(), status, artifacts, approval, sha("pkg").as_str()],
        )
        .expect("legacy row");
    }

    /// Stored artifacts JSON of a schema-4 build whose package holds `contents`.
    /// Its checks predate advisory checks, so they have no `advisory` field.
    fn artifacts_json(dir: &Path, contents: &[u8]) -> String {
        let mut value = serde_json::to_value(files(dir, contents)).expect("files");
        value["checks"] = json!([{ "id": "slice.slice_succeeded", "passed": true, "detail": "return_code 0" }]);
        value.to_string()
    }

    fn schema_4() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(MIGRATION_004).expect("migration 004");
        conn
    }

    #[test]
    fn migrated_revisions_keep_their_ids_ancestry_and_statuses_on_legacy_builds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = schema_4();
        let key = sha("same spec");
        // The same build key in two designs with different package bytes: the
        // old index allowed it, and the new one must not refuse the migration.
        insert(&conn, "a-1", "a", 1, &key, "verified", "approved", Some(artifacts_json(dir.path(), b"one")));
        insert(&conn, "a-2", "a", 2, &sha("other"), "failed", "pending", None);
        insert(&conn, "b-1", "b", 1, &key, "verified", "void", Some(artifacts_json(dir.path(), b"two")));
        migrate_to_6(&mut conn);

        let a2 = get(&conn, &RevisionId("a-2".into())).expect("a-2");
        assert_eq!((a2.number, a2.parent_id.as_ref().map(RevisionId::as_str), a2.kind.as_str()), (2, Some("a-1"), "sign"));
        assert!(matches!(a2.build, BuildState::Failed { artifacts: None, .. }));
        let a1 = get(&conn, &RevisionId("a-1".into())).expect("a-1");
        assert_eq!(a1.build_id.as_str(), "a-1", "a legacy build keeps its revision's id");
        assert!(matches!(a1.build, BuildState::Verified { ref artifacts } if !artifacts.checks()[0].advisory));
        assert!(matches!(a1.approval, Approval::Approved { ref acknowledged_warnings, .. } if acknowledged_warnings.is_empty()));
        assert!(matches!(get(&conn, &RevisionId("b-1".into())).expect("b-1").approval, Approval::Void { .. }));
        let legacy: i64 = conn.query_row("SELECT count(*) FROM builds WHERE legacy = 1 AND check_plan = 'sign-legacy'", [], |r| r.get(0)).expect("count");
        assert_eq!(legacy, 3);
    }

    #[test]
    fn an_identical_spec_reuses_an_intact_legacy_build_and_rebuilds_a_changed_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = schema_4();
        let (intact, changed) = (sha("intact spec"), sha("changed spec"));
        insert(&conn, "a-1", "a", 1, &intact, "verified", "approved", Some(artifacts_json(dir.path(), b"intact")));
        let tampered = artifacts_json(dir.path(), b"before");
        insert(&conn, "b-1", "b", 1, &changed, "verified", "approved", Some(tampered.clone()));
        let path: String = serde_json::from_str::<serde_json::Value>(&tampered).expect("json")["package_path"].as_str().expect("path").into();
        fs::write(path, b"after").expect("tamper");
        migrate_to_6(&mut conn);

        let mut again = request("intact spec", None, Actor::Agent);
        again.build_key = intact;
        let revision = reused(claim(&mut conn, &again).expect("claim"));
        assert_eq!(revision.build_id.as_str(), "a-1", "the legacy build is reused by its unchanged key");
        assert_eq!(revision.id.as_str(), "a-1", "an identical request returns the existing revision");

        let mut elsewhere = request("intact spec", Some(LineageId("a".into())), Actor::Agent);
        elsewhere.build_key = sha("a new spec");
        started(claim(&mut conn, &elsewhere).expect("claim"));
        let mut back = request("intact spec", Some(LineageId("a".into())), Actor::Agent);
        back.build_key = sha("intact spec");
        let back = reused(claim(&mut conn, &back).expect("claim"));
        assert_eq!((back.number, back.build_id.as_str()), (3, "a-1"), "returning to the legacy spec reuses its build");

        let mut rebuild = request("changed spec", None, Actor::Agent);
        rebuild.build_key = changed;
        let fresh = started(claim(&mut conn, &rebuild).expect("claim"));
        assert_ne!(fresh.build_id.as_str(), "b-1", "a legacy build whose package changed is not reused");
        let old = get(&conn, &RevisionId("b-1".into())).expect("b-1");
        assert!(matches!(old.build, BuildState::Invalid { .. }));
        assert!(matches!(old.approval, Approval::Void { ref reason, .. } if reason.starts_with("package changed on disk")));
    }

    /// Legacy builds can share a key with different packages. When the newest
    /// one's package changed, an older intact one is still reused.
    #[test]
    fn a_changed_legacy_build_does_not_hide_an_older_intact_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut conn = schema_4();
        let key = sha("shared spec");
        insert(&conn, "a-1", "a", 1, &key, "verified", "pending", Some(artifacts_json(dir.path(), b"older, intact")));
        let tampered = artifacts_json(dir.path(), b"newer, before");
        insert(&conn, "b-1", "b", 1, &key, "verified", "pending", Some(tampered.clone()));
        insert(&conn, "c-1", "c", 1, &sha("another spec"), "verified", "pending", Some(artifacts_json(dir.path(), b"other")));
        let path: String = serde_json::from_str::<serde_json::Value>(&tampered).expect("json")["package_path"].as_str().expect("path").into();
        fs::write(path, b"newer, after").expect("tamper");
        migrate_to_6(&mut conn);

        let mut request = request("shared spec", Some(LineageId("c".into())), Actor::Agent);
        request.build_key = key;
        let revision = reused(claim(&mut conn, &request).expect("claim"));
        assert_eq!((revision.number, revision.build_id.as_str()), (2, "a-1"), "the older intact legacy build is reused");
        let newer = get(&conn, &RevisionId("b-1".into())).expect("b-1");
        assert!(matches!(newer.build, BuildState::Invalid { .. }), "the changed one is invalidated");
        assert_eq!(newer.approval, Approval::Pending, "nobody approved it, so nothing is voided");
        assert_eq!(count(&conn, "builds"), 3, "nothing was built");
    }
}
