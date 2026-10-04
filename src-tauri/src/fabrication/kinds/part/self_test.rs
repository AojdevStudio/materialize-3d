//! `materialize-3d --cad-self-test <dir>`: the release's clean-install test
//! builds the reference cable clip through the app itself.
//!
//! The build is the app's own: the CAD runtime bundled beside this binary
//! (the signed helper and the image, verified as any launch verifies them),
//! the part kind, and the shared pipeline with the installed Bambu Studio.
//! The script is compiled in, so the flag runs no caller-supplied code. State
//! goes into a fresh database and workspace under `dir`, never the person's
//! app data.

use std::path::Path;

use serde_json::{json, Value};

use super::Part;
use crate::fabrication::cad_worker::CadRuntime;
use crate::fabrication::kind::{BuildControl, ObjectKind};
use crate::fabrication::package;
use crate::fabrication::pipeline::{self, BuildRequest, Workspace};
use crate::fabrication::revisions::{Actor, BuildState};
use crate::state::AppState;

const CLIP_SOURCE: &str = include_str!("../../../../tests/fixtures/parts/cable-clip.py");
const SPECS: &str = include_str!("../../../../tests/fixtures/parts/specs.json");

/// The reference cable clip's spec (design.md, Usage).
pub fn cable_clip_spec() -> Value {
    let specs: Value = serde_json::from_str(SPECS).expect("the compiled-in specs parse");
    let mut spec = specs["cable-clip"].clone();
    spec["schema_version"] = json!(1);
    spec["source"] = json!(CLIP_SOURCE);
    spec
}

/// Builds the cable clip under `dir`, which must be absent or empty, and
/// returns what a person would check: the build, every check, the package
/// hash, and whether the STEP is inside the package. `Ok` only when the build
/// verified.
pub fn run(dir: &Path) -> Result<Value, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.next().is_some() {
        return Err(format!("{} must be absent or empty", dir.display()));
    }
    let runtime = CadRuntime::bundled().map_err(|e| e.to_string())?;
    let state = AppState::default();
    let conn = crate::database::init_db(&dir.join("self-test.db")).map_err(|e| format!("database: {e}"))?;
    *state.db.lock().map_err(|_| "database lock poisoned")? = Some(conn);
    let workspace = Workspace::new(&dir.join("data"), &dir.join("cache")).with_cad_runtime(Some(runtime));
    let request = BuildRequest { kind: Part::ID.as_str().into(), spec: cable_clip_spec(), lineage_id: None, actor: Actor::Human };
    let built = pipeline::build(&state, &workspace, request, &BuildControl::new(&|_| {}, &|| false)).map_err(|e| e.to_string())?;
    let revision = built.revision;
    let artifacts = revision.artifacts();
    let step_inside = match artifacts {
        Some(artifacts) => {
            let bytes = std::fs::read(&artifacts.files().package_path).map_err(|e| format!("package: {e}"))?;
            package::included_step(&bytes).map_err(|e| e.to_string())?.is_some()
        }
        None => false,
    };
    let summary = json!({
        "build": match &revision.build {
            BuildState::Verified { .. } => "verified",
            BuildState::Failed { .. } => "failed",
            BuildState::Building => "building",
            BuildState::Invalid { .. } => "invalid",
        },
        "failure": match &revision.build { BuildState::Failed { reason, .. } => Some(reason.clone()), _ => None },
        "checks": artifacts.map(|a| a.checks().to_vec()).unwrap_or_default(),
        "package_sha256": artifacts.map(|a| a.files().package_sha256.to_string()),
        "step_inside_package": step_inside,
    });
    if matches!(revision.build, BuildState::Verified { .. }) && step_inside {
        Ok(summary)
    } else {
        Err(serde_json::to_string_pretty(&summary).unwrap_or_default())
    }
}

/// The app binary's entry for the flag: prints the summary or the failure and
/// returns the process exit code.
pub fn main(dir: Option<&std::ffi::OsStr>) -> i32 {
    let Some(dir) = dir else {
        eprintln!("usage: materialize-3d --cad-self-test <empty or absent directory>");
        return 64;
    };
    match run(Path::new(dir)) {
        Ok(summary) => {
            println!("{}", serde_json::to_string_pretty(&summary).unwrap_or_default());
            0
        }
        Err(failure) => {
            eprintln!("cad self-test failed: {failure}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fabrication::printer::P2S_04;

    #[test]
    fn the_compiled_in_clip_is_the_designs_and_validates() {
        let spec = cable_clip_spec();
        assert_eq!(spec["title"], "Six USB-C desk clip");
        assert!(spec["source"].as_str().expect("source").contains("fillet(clip.edges().filter_by(Axis.X)"));
        let valid = super::super::ValidPart::parse(serde_json::from_value(spec).expect("shape"), &P2S_04).expect("valid");
        assert_eq!(valid.requirements().len(), 2);
    }

    #[test]
    fn without_a_bundled_runtime_the_self_test_fails_before_building() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = run(&dir.path().join("self-test")).expect_err("no runtime beside a test binary");
        assert!(err.contains("not bundled"), "{err}");
    }
}
