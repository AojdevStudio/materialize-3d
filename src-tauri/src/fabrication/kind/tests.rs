use std::cell::RefCell;

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::json;

use super::*;
use crate::fabrication::checks::{test_support, CheckId, CheckPhase, CheckPlanId};
use crate::fabrication::printer::P2S_04;

/// A kind for tests: one body, one blocking geometry check, and one advisory
/// print check, whose outcomes the spec decides.
struct Probe;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ProbeSpec {
    geometry_passes: bool,
    print_passes: bool,
}

#[derive(Serialize)]
struct ValidProbe {
    geometry_passes: bool,
    print_passes: bool,
}

fn tip() -> CheckId {
    CheckId::new(CheckPhase::Geometry, "tip.probe")
}

fn overhang() -> CheckId {
    CheckId::new(CheckPhase::Print, "overhang.probe")
}

impl ObjectKind for Probe {
    type Spec = ProbeSpec;
    type Valid = ValidProbe;
    const ID: KindId = KindId::new("probe");
    const TAG: &'static str = "probe-1";
    const SUMMARY: &'static str = "a kind for tests";
    const GUIDE: &'static str = "how to probe";

    fn validate(spec: ProbeSpec, _printer: &PrinterProfile) -> Result<ValidProbe, SpecError> {
        Ok(ValidProbe { geometry_passes: spec.geometry_passes, print_passes: spec.print_passes })
    }

    fn title(_valid: &ValidProbe) -> String {
        "Probe".into()
    }

    fn check_plan(_valid: &ValidProbe, _printer: &PrinterProfile) -> Result<CheckPlan, InvalidPlan> {
        CheckPlan::new(CheckPlanId::new("probe-checks-1"), vec![tip(), overhang()])
    }

    fn model(_valid: &ValidProbe, _ctx: &KernelContext, _control: &BuildControl<'_>) -> Result<Built, KernelError> {
        Ok(Built { model: test_support::model(), extra: Vec::new() })
    }

    fn measure(valid: &ValidProbe, _model: &PrintableModel, _control: &BuildControl<'_>) -> Result<Vec<CheckOutcome>, KernelError> {
        Ok(vec![
            CheckOutcome { id: tip(), passed: valid.geometry_passes, detail: "tip".into() },
            CheckOutcome { id: overhang(), passed: valid.print_passes, detail: "62 degrees".into() },
        ])
    }

    fn preview(_valid: &ValidProbe, _model: &PrintableModel) -> Result<ViewSet, KernelError> {
        ViewSet::new(vec![(View::Isometric, b"png".to_vec()), (View::Top, b"top".to_vec())])
    }
}

const PROBE: Kind<Probe> = Kind::NEW;
fn ctx() -> KernelContext {
    KernelContext::without_runtime(P2S_04)
}

fn prepare(driver: &dyn KindDriver, parsed: &ParsedSpec) -> (Result<PreparedObject, BuildError>, Vec<BuildStep>) {
    let steps = RefCell::new(Vec::new());
    let result = driver.prepare(parsed, &ctx(), &BuildControl::new(&|step| steps.borrow_mut().push(step), &|| false));
    (result, steps.into_inner())
}

#[test]
fn the_registry_names_each_kind_once_in_snake_case() {
    let ids: Vec<&str> = KINDS.iter().map(|kind| kind.id().as_str()).collect();
    assert_eq!(ids, ["sign", "part"]);
    let mut unique = ids.clone();
    unique.dedup();
    assert_eq!(unique, ids, "duplicate kind id");
    for id in ids {
        let snake = id.starts_with(|c: char| c.is_ascii_lowercase())
            && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
        assert!(snake, "{id} is not snake_case");
        assert_eq!(find(id).map(|kind| kind.id().as_str()), Some(id));
    }
    assert!(find("imported_part").is_none(), "an unregistered kind is not found");
}

#[test]
fn an_advisory_failure_is_a_warning_and_the_model_is_still_certified() {
    let parsed = PROBE.parse(json!({ "geometry_passes": true, "print_passes": false }), &P2S_04).expect("parse");
    let (prepared, steps) = prepare(&PROBE, &parsed);
    let prepared = prepared.expect("an advisory failure does not stop the build");
    assert_eq!(prepared.checked.geometry().warnings().collect::<Vec<_>>(), [&overhang()]);
    assert_eq!(prepared.views.preview(), b"png");
    assert_eq!(prepared.views.views().iter().map(|(view, _)| *view).collect::<Vec<_>>(), [View::Isometric, View::Top]);
    assert_eq!(steps, [BuildStep::GeometryBuilt]);
}

#[test]
fn a_blocking_failure_stops_the_build_at_the_geometry_stage_before_packaging() {
    let parsed = PROBE.parse(json!({ "geometry_passes": false, "print_passes": false }), &P2S_04).expect("parse");
    let (prepared, _) = prepare(&PROBE, &parsed);
    match prepared {
        Err(BuildError::Stage { stage: Stage::Geometry, error }) => {
            assert_eq!(error, "checks failed: geometry.tip.probe: tip", "only the blocking check fails it")
        }
        Err(other) => panic!("expected a failed build, got {other}"),
        Ok(_) => panic!("a failed geometry check certified the model"),
    }
}

#[test]
fn a_spec_builds_only_as_the_kind_that_parsed_it() {
    let parsed = PROBE.parse(json!({ "geometry_passes": true, "print_passes": true }), &P2S_04).expect("parse");
    let (prepared, steps) = prepare(&Kind::<Sign>::NEW, &parsed);
    assert!(matches!(prepared, Err(BuildError::Failed(ref reason)) if reason == "a probe spec cannot build as sign"));
    assert!(steps.is_empty(), "nothing ran");
}

#[test]
fn parse_refuses_unknown_fields_and_hashes_the_validated_spec() {
    let err = PROBE.parse(json!({ "geometry_passes": true, "print_passes": true, "actor": "human" }), &P2S_04).err().expect("refused");
    assert!(err.to_string().starts_with("malformed spec: unknown field `actor`"), "{err}");

    let a = PROBE.parse(json!({ "geometry_passes": true, "print_passes": false }), &P2S_04).expect("parse");
    let b = PROBE.parse(json!({ "print_passes": false, "geometry_passes": true }), &P2S_04).expect("parse");
    assert_eq!(a.spec_sha256(), b.spec_sha256(), "field order does not change the hash");
    assert_eq!((a.kind(), a.tag(), a.title()), (KindId::new("probe"), "probe-1", "Probe"));
    assert_eq!(a.plan().id(), CheckPlanId::new("probe-checks-1"));
}

/// Without a verified CAD runtime, `part` stays registered but is not
/// available; signs need nothing and are always available.
#[test]
fn part_is_unavailable_without_a_verified_runtime_and_signs_are_unaffected() {
    let ids: Vec<&str> = available(&ctx()).iter().map(|kind| kind.id().as_str()).collect();
    assert_eq!(ids, ["sign"]);
    let part = find("part").expect("part is registered");
    assert!(!part.available(&ctx()));
    assert!(find("sign").expect("sign").available(&ctx()));
    assert_eq!(part.key_inputs(&ctx()), Vec::<String>::new(), "no runtime, nothing to key on");
}

#[test]
fn only_a_part_names_its_object_after_the_build_key() {
    let key = Sha256Hex::of_bytes(b"key");
    assert_eq!(find("sign").expect("sign").naming(), ObjectNaming::Title);
    assert_eq!(find("part").expect("part").naming(), ObjectNaming::BuildKey);
    assert_eq!(ObjectNaming::Title.object_name("Six USB-C desk clip", &key), "Six USB-C desk clip");
    assert_eq!(ObjectNaming::BuildKey.object_name("Six USB-C desk clip", &key), format!("part-{}", &key.as_str()[..12]));
}
