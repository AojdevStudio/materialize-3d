//! `import_part` end to end: through the registry's tool on the MCP surface,
//! the shared actions, the input store, and (for the build) the real slicer.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::json;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::*;
use crate::actions::{ActionError, Actions};
use crate::fabrication::checks::CheckId;
use crate::fabrication::kinds::imported_part::tests::{binary_stl, one_body_3mf, slab_on_a_post, zip_of};
use crate::fabrication::kinds::imported_part::MAX_ZIP_ENTRIES;
use crate::fabrication::revisions::{Approval, BuildState};
use crate::tools::{Surface, Tool, ToolCall, ToolError};

struct Lane {
    dir: tempfile::TempDir,
    state: Arc<AppState>,
    actions: Arc<Actions>,
}

/// The shared actions over a fresh database, with no CAD runtime: an import
/// needs no guest.
fn lane() -> Lane {
    let dir = tempfile::tempdir().expect("tempdir");
    let state = Arc::new(AppState::default());
    *state.db.lock().expect("db lock") = Some(crate::database::init_db(&dir.path().join("test.db")).expect("init db"));
    let workspace = Workspace::new(&dir.path().join("data"), &dir.path().join("cache")).with_cad_runtime(None);
    let actions = Arc::new(Actions::new(Arc::new(|_, _| {}), state.clone(), workspace));
    Lane { dir, state, actions }
}

impl Lane {
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.dir.path().join(name);
        fs::write(&path, bytes).expect("write");
        path
    }

    async fn import(&self, path: &Path, title: &str, units: &str) -> Result<crate::tools::ToolContent, ToolError> {
        let call = ToolCall {
            surface: Surface::ExternalMcp,
            actions: self.actions.clone(),
            progress: Arc::new(|_| {}),
            cancel: CancellationToken::new(),
            blocking: TaskTracker::new(),
        };
        Tool::ImportPart.invoke(&call, json!({ "path": path.display().to_string(), "title": title, "units": units })).await
    }

    fn stored(&self) -> Vec<String> {
        match fs::read_dir(self.dir.path().join("data").join("inputs")) {
            Ok(entries) => entries.map(|e| e.expect("entry").file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => Vec::new(),
        }
    }
}

/// Each bad file is refused with a bounded error before anything is stored
/// or recorded, and before any slicer is looked for.
#[tokio::test(flavor = "multi_thread")]
async fn import_part_refuses_oversized_bombed_traversing_and_non_mesh_files() {
    let lane = lane();
    let piece = slab_on_a_post(0.0);
    let oversized = lane.dir.path().join("huge.stl");
    fs::File::create(&oversized).expect("create").set_len(inputs::MAX_INPUT_BYTES + 1).expect("grow");

    let mut declared = zip_of(&[("3D/3dmodel.model", b"<model/>".as_slice()), ("Metadata/big.bin", b"tiny".as_slice())]);
    let directory = declared.windows(4).rposition(|w| w == b"PK\x01\x02").expect("directory entry");
    declared[directory + 24..directory + 28].copy_from_slice(&(300u32 << 20).to_le_bytes());
    let names: Vec<String> = (0..=MAX_ZIP_ENTRIES).map(|i| format!("Metadata/{i}.png")).collect();
    let many = zip_of(&names.iter().map(|name| (name.as_str(), b"x".as_slice())).collect::<Vec<_>>());
    let traversal = zip_of(&[("3D/3dmodel.model", b"<model/>".as_slice()), ("../../escape.sh", b"rm -rf ~".as_slice())]);

    let cases = [
        ("an oversized file", oversized, "larger than"),
        ("a zip bomb by declared size", lane.file("declared.3mf", &declared), "expands to more than"),
        ("a zip bomb by entry count", lane.file("many.3mf", &many), "zip entries"),
        ("a zip entry name with traversal", lane.file("traversal.3mf", &traversal), "leaves its folder"),
        ("a non-mesh file", lane.file("notes.3mf", b"#!/bin/sh\necho not a mesh\n"), "not a 3MF or an STL mesh"),
        ("a relative path", PathBuf::from("bracket.3mf"), "must be absolute"),
    ];
    for (why, path, says) in cases {
        let refused = lane.import(&path, "Shelf bracket", "mm").await.expect_err(why);
        let ToolError::Action(ActionError::Build(err @ (BuildError::Input(_) | BuildError::Mesh(_)))) = &refused else {
            panic!("{why}: {refused}")
        };
        assert!(err.to_string().starts_with("import refused: ") && err.to_string().contains(says), "{why}: {err}");
    }
    assert!(lane.actions.list(10).expect("list").is_empty(), "no revision was recorded");
    assert!(lane.stored().is_empty(), "nothing was stored: {:?}", lane.stored());
    let bad_units = lane.import(&lane.file("ok.stl", &binary_stl(&piece)), "Shelf bracket", "cm").await;
    assert!(matches!(bad_units, Err(ToolError::InvalidArguments(_))), "{bad_units:?}");
    assert!(lane.stored().is_empty());
}

/// A 3MF from Fusion with an overhang: the imported part verifies, its
/// overhang is a warning, and approval binds to exactly the warnings shown.
/// Importing the same bytes, title, and units again reuses the stored input
/// and the revision.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a validated Bambu Studio (BAMBU_STUDIO_CLI or a standard install)"]
async fn an_imported_3mf_verifies_with_print_warnings_and_approval_binds_to_them() {
    let lane = lane();
    let bracket = lane.file("bracket.3mf", &one_body_3mf(&slab_on_a_post(5.0)));
    let content = lane.import(&bracket, "Shelf bracket", "mm").await.expect("import");
    let result = &content.value;
    println!("{}", serde_json::to_string_pretty(result).expect("json"));
    assert_eq!((result["kind"].as_str(), result["build"].as_str()), (Some("imported_part"), Some("verified")), "{result}");
    assert_eq!((result["requested_by"].as_str(), result["reused"].as_bool()), (Some("external_mcp"), Some(false)));
    assert_eq!(result["checks_passed"], result["checks_total"], "every blocking check passes");
    assert_eq!(result["size_mm"], json!([40.0, 40.0, 13.0]), "set on the bed");
    let warnings: Vec<&str> = result["warnings"].as_array().expect("warnings").iter().filter_map(|w| w.as_str()).collect();
    assert!(warnings.iter().any(|w| w.starts_with("print.overhang.body: ")), "{warnings:?}");
    assert!(warnings.iter().all(|w| w.starts_with("print.") || w.starts_with("slice.support_warning")), "{warnings:?}");
    assert_eq!(content.views.iter().map(|(view, _)| *view).collect::<Vec<_>>(), [View::Isometric, View::Front, View::Top]);

    let id = revisions::RevisionId::parse(result["revision_id"].as_str().expect("id")).expect("revision id");
    let revision = with_db(&lane.state, |conn| revisions::get(conn, &id)).expect("get");
    let artifacts = revision.artifacts().expect("artifacts");
    let shown: BTreeSet<CheckId> = artifacts.warnings().into_iter().map(|w| CheckId::try_from(w.to_owned()).expect("id")).collect();
    let hash = &artifacts.files().package_sha256;
    let mut fewer = shown.clone();
    fewer.pop_first();
    for wrong in [BTreeSet::new(), fewer] {
        let refused = with_db(&lane.state, |conn| revisions::approve(conn, &id, hash, &wrong, Actor::Human));
        assert!(matches!(refused, Err(BuildError::Revision(RevisionError::WarningsMismatch { .. }))), "{refused:?}");
    }
    let approved = with_db(&lane.state, |conn| revisions::approve(conn, &id, hash, &shown, Actor::Human)).expect("approve");
    assert!(matches!(approved.approval, Approval::Approved { .. }));

    let again = lane.import(&bracket, "Shelf bracket", "mm").await.expect("import again");
    assert_eq!((again.value["revision_id"].as_str(), again.value["reused"].as_bool()), (Some(id.as_str()), Some(true)));
    assert_eq!(lane.stored(), [Sha256Hex::of_file(&bracket).expect("hash").to_string()], "one stored input");
    assert!(matches!(revision.build, BuildState::Verified { .. }));
}
