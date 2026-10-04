//! The part kind on a real CAD backend and the real Bambu Studio slicer.
//!
//! Each test boots real guests, so each needs a host that can:
//! - Linux, with `--features linux-cad-test`: KVM, `/dev/vhost-vsock`, QEMU
//!   (`M3D_QEMU`, default `qemu-system-x86_64`), and the amd64 runtime that
//!   matches `cad-runtime/pins-amd64.json` in `M3D_CAD_RUNTIME`;
//! - macOS: the helper, signed with the virtualization entitlement, in
//!   `M3D_CAD_HELPER`, and the arm64 runtime in `M3D_CAD_RUNTIME`;
//!
//! and Bambu Studio 02.08.02.61 (`BAMBU_STUDIO_CLI` or a standard install).
//! The self-hosted runners run them (`.github/workflows/cad-runtime.yml`):
//!
//! ```sh
//! M3D_CAD_RUNTIME=cad-runtime/out/amd64 BAMBU_STUDIO_CLI=... \
//!   cargo test --lib --locked --features linux-cad-test fabrication::kinds::part::backend_tests \
//!   -- --ignored --nocapture --test-threads=1
//! ```

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::fabrication::cad_worker::CadRuntime;
use crate::fabrication::checks::CheckId;
use crate::fabrication::kind::BuildControl;
use crate::fabrication::package;
use crate::fabrication::pipeline::{self, BuildError, BuildOutcome, BuildRequest, Stage, Workspace};
use crate::fabrication::revisions::{self, Actor, Approval, BuildState, ExportFormat, Revision, RevisionError, Sha256Hex};
use crate::state::AppState;

const NEEDS: &str = "needs a CAD backend (M3D_CAD_RUNTIME) and Bambu Studio";

fn env_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is set")))
}

/// The runtime under test, verified against the pins compiled into this build.
fn runtime() -> CadRuntime {
    #[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
    {
        use crate::fabrication::cad_worker::MicroVmConfig;
        let qemu = std::env::var_os("M3D_QEMU").map_or_else(|| PathBuf::from("qemu-system-x86_64"), PathBuf::from);
        CadRuntime::linux_microvm(MicroVmConfig { qemu }, &env_path("M3D_CAD_RUNTIME")).expect("the runtime verifies")
    }
    #[cfg(target_os = "macos")]
    {
        use crate::fabrication::cad_worker::VerifiedHostHelper;
        let helper = VerifiedHostHelper::verify(&env_path("M3D_CAD_HELPER")).expect("the helper verifies");
        CadRuntime::mac_vm(helper, &env_path("M3D_CAD_RUNTIME")).expect("the runtime verifies")
    }
}

/// A spec from `tests/fixtures/parts`: the script `<name>.py` and the rest from `specs.json`.
fn spec(name: &str) -> Value {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/parts");
    let source = std::fs::read_to_string(dir.join(format!("{name}.py"))).expect("script");
    let specs: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("specs.json")).expect("specs")).expect("json");
    let mut spec = specs[name].clone();
    spec["schema_version"] = json!(1);
    spec["source"] = json!(source);
    spec
}

struct Harness {
    dir: tempfile::TempDir,
    state: AppState,
    workspace: Workspace,
}

impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = AppState::default();
        *state.db.lock().expect("db lock") = Some(crate::database::init_db(&dir.path().join("test.db")).expect("init db"));
        let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache")).with_cad_runtime(Some(runtime()));
        Self { dir, state, workspace }
    }

    fn build(&self, spec: Value) -> Result<BuildOutcome, BuildError> {
        let request = BuildRequest { kind: "part".into(), spec, lineage_id: None, actor: Actor::Agent };
        pipeline::build(&self.state, &self.workspace, request, &BuildControl::new(&|_| {}, &|| false))
    }

    fn db<T>(&self, f: impl FnOnce(&mut rusqlite::Connection) -> revisions::Result<T>) -> revisions::Result<T> {
        let mut guard = self.state.db.lock().expect("db lock");
        f(guard.as_mut().expect("db"))
    }
}

fn print_checks(name: &str, revision: &Revision) {
    match &revision.build {
        BuildState::Failed { reason, .. } => println!("== {name}: failed: {reason}"),
        BuildState::Verified { .. } => println!("== {name}: verified"),
        other => println!("== {name}: {other:?}"),
    }
    for check in revision.artifacts().map(|a| a.checks()).unwrap_or_default() {
        let verdict = match (check.passed, check.advisory) {
            (true, _) => "PASS",
            (false, true) => "WARN",
            (false, false) => "FAIL",
        };
        println!("{verdict} {} {}", check.id, check.detail);
    }
}

/// The build's warnings, as a person acknowledges them.
fn warnings(revision: &Revision) -> BTreeSet<CheckId> {
    let artifacts = revision.artifacts().expect("artifacts");
    artifacts.warnings().into_iter().map(|id| CheckId::try_from(id.to_owned()).expect("check id")).collect()
}

#[test]
#[ignore = "needs a CAD backend (M3D_CAD_RUNTIME) and Bambu Studio"]
fn the_three_proof_parts_verify_on_the_real_slicer_with_every_requirement_measured() {
    let _ = NEEDS;
    let h = Harness::new();
    let kinds: Vec<&str> = crate::fabrication::kind::available(&h.workspace.kernel_context()).iter().map(|k| k.id().as_str()).collect();
    assert_eq!(kinds, ["sign", "part"], "a verified runtime makes part available");
    for (name, requirements) in [("cable-clip", 2), ("threaded-cap", 3), ("gridfinity-bin", 4)] {
        let built = h.build(spec(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        print_checks(name, &built.revision);
        assert!(matches!(built.revision.build, BuildState::Verified { .. }), "{name} verifies");
        let artifacts = built.revision.artifacts().expect("artifacts");
        let measured: Vec<_> = artifacts.checks().iter().filter(|c| c.id.starts_with("geometry.requirement.")).collect();
        assert_eq!(measured.len(), requirements, "{name}: every requirement is a check");
        assert!(measured.iter().all(|c| c.passed), "{name}: every requirement is met");
        let package = std::fs::read(&artifacts.files().package_path).expect("package");
        let step = package::included_step(&package).expect("zip").expect("the STEP is inside the package");
        assert!(step.starts_with(b"ISO-10303-21;"), "{name}: a STEP file");
        let body = name.split('-').next_back().unwrap_or(name);
        assert!(String::from_utf8_lossy(&step).contains(&format!("PRODUCT('{}'", if body == "clip" { "clip" } else { body })), "{name}: the body is named in the STEP");
    }
}

/// Bambu Studio's real support warning about the part's own object is
/// recorded as an advisory `slice.support_warning`, beside the app's
/// `print.overhang` warning. Approval takes exactly those warnings, and the
/// STEP exports from the approved package with its own hash.
#[test]
#[ignore = "needs a CAD backend (M3D_CAD_RUNTIME) and Bambu Studio"]
fn an_overhanging_part_verifies_with_bambus_support_warning_as_advisory() {
    let h = Harness::new();
    let built = h.build(spec("overhang-tee")).expect("build");
    print_checks("overhang-tee", &built.revision);
    assert!(matches!(built.revision.build, BuildState::Verified { .. }), "a part that needs supports still verifies");
    let artifacts = built.revision.artifacts().expect("artifacts");
    let check = |id: &str| artifacts.checks().iter().find(|c| c.id == id).unwrap_or_else(|| panic!("{id}")).clone();
    let support = check("slice.support_warning");
    let object = format!("part-{}", &built.revision.build_key.as_str()[..12]);
    assert!(!support.passed && support.advisory, "{support:?}");
    assert!(
        support.detail.contains(&format!("It seems object {object} has ")) && support.detail.ends_with(". Please re-orient the object or enable support generation."),
        "Bambu's exact words about the app-chosen object: {}",
        support.detail
    );
    assert!(check("slice.no_warnings").passed, "the support warning is not a failure");
    let overhang = check("print.overhang.tee");
    assert!(!overhang.passed && overhang.advisory, "{overhang:?}");

    let acknowledged = warnings(&built.revision);
    assert!(acknowledged.contains(&CheckId::try_from("print.overhang.tee".to_owned()).expect("id")));
    assert!(acknowledged.contains(&CheckId::try_from("slice.support_warning".to_owned()).expect("id")));
    let hash = artifacts.files().package_sha256.clone();
    let id = built.revision.id.clone();
    let mut fewer = acknowledged.clone();
    fewer.pop_first();
    for wrong in [BTreeSet::new(), fewer] {
        let refused = h.db(|conn| revisions::approve(conn, &id, &hash, &wrong, Actor::Human));
        assert!(matches!(refused, Err(RevisionError::WarningsMismatch { .. })), "{refused:?}");
    }
    let approved = h.db(|conn| revisions::approve(conn, &id, &hash, &acknowledged, Actor::Human)).expect("approve");
    assert!(matches!(approved.approval, Approval::Approved { .. }));

    let out = h.dir.path().join("exports/tee.step");
    h.db(|conn| revisions::export(conn, &id, ExportFormat::IncludedStep, &out)).expect("export the STEP");
    let package = std::fs::read(&artifacts.files().package_path).expect("package");
    assert_eq!(std::fs::read(&out).expect("step"), package::included_step(&package).expect("zip").expect("step"));
    let recorded: String = h
        .db(|conn| Ok(conn.query_row("SELECT sha256 FROM revision_exports WHERE format = 'included_step'", [], |row| row.get(0))?))
        .expect("export record");
    assert_eq!(recorded, Sha256Hex::of_file(&out).expect("hash").to_string());
}

#[test]
#[ignore = "needs a CAD backend (M3D_CAD_RUNTIME) and Bambu Studio"]
fn a_failing_fillet_returns_a_bounded_error_at_generate_and_records_the_revision() {
    let h = Harness::new();
    let failed = h.build(spec("failing-fillet")).expect("a failed script is a failed revision, not an error").revision;
    println!("{:?}", failed.build);
    assert_eq!(Stage::of_failure(&failed.build), Some(Stage::Generate));
    let BuildState::Failed { reason, .. } = &failed.build else { panic!("a failed build, got {:?}", failed.build) };
    let error = reason.strip_prefix("generate: ").expect("the reason names the stage");
    assert!(error.starts_with("line 10: ValueError: Failed creating a fillet"), "{error}");
    assert!(error.chars().count() <= 2000);
    let recorded = h.db(|conn| revisions::list_recent(conn, 10)).expect("list");
    assert_eq!(recorded, [failed], "the revision is recorded");
}

/// The script forges a verdict, a mesh, and a check list, prints a pass, and
/// brings its own Body type. The build is judged only by the inspector's mesh
/// and Rust: a 10 mm box misses its declared 20 mm width, and an open shell
/// never becomes a part.
#[test]
#[ignore = "needs a CAD backend (M3D_CAD_RUNTIME) and Bambu Studio"]
fn a_hostile_script_cannot_change_its_own_checks() {
    let h = Harness::new();
    let failed = h.build(spec("hostile")).expect("the box is 10 mm, not 20: a failed revision").revision;
    println!("{:?}", failed.build);
    assert!(
        matches!(&failed.build, BuildState::Failed { reason, .. } if reason == "geometry: checks failed: geometry.requirement.0: width 10.00 mm (20 ± 0.1)"),
        "{:?}",
        failed.build
    );
    assert_eq!(Stage::of_failure(&failed.build), Some(Stage::Geometry));

    let mut open = spec("hostile");
    open["params"]["open"] = json!(true);
    let failed = h.build(open).expect("an open shell is not a solid: a failed revision").revision;
    println!("{:?}", failed.build);
    assert!(matches!(&failed.build, BuildState::Failed { reason, .. } if reason == "inspect: shape 0 has no solid"), "{:?}", failed.build);
}
