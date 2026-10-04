use serde_json::{json, Value};

use super::*;
use crate::fabrication::checks::{handoff_settings_match_slice, CheckOutcome};
use crate::fabrication::kind::{Kind, KindDriver};
use crate::fabrication::model::{Mesh, Palette};
use crate::fabrication::printer::{Um, P2S_04};

/// The design's cable clip spec (design.md, Usage), with `source` elided.
pub(crate) fn clip_spec() -> Value {
    json!({
        "schema_version": 1, "title": "Six USB-C desk clip",
        "source": "from build123d import *\n\ndef build(p): ...",
        "params": {"cables": 6, "cable_d": 4, "clearance": 0.4, "desk_t": 18, "span": 60,
                   "depth": 25, "wall": 3, "fillet": 1.2},
        "requirements": [
            {"measure": "span", "name": "width", "axis": "x", "mm": 60, "tol": 0.2},
            {"measure": "opening", "name": "desk jaw", "axis": "z", "at": [0, 14, 12], "mm": 18.4, "tol": 0.2}],
        "filaments": [{"slot": 1, "name": "Black"}]
    })
}

fn valid(spec: Value) -> ValidPart {
    ValidPart::parse(serde_json::from_value(spec).expect("spec shape"), &P2S_04).expect("valid")
}

fn refused(spec: Value) -> String {
    match serde_json::from_value::<PartSpec>(spec) {
        Ok(spec) => ValidPart::parse(spec, &P2S_04).expect_err("refused").to_string(),
        Err(e) => e.to_string(),
    }
}

type Piece = (Vec<[Um; 3]>, Vec<[u32; 3]>);

/// A closed, outward box from `lo` to `hi`, µm.
fn cuboid(lo: [Um; 3], hi: [Um; 3]) -> Piece {
    let v = (0..8)
        .map(|i| [if i & 1 == 0 { lo[0] } else { hi[0] }, if i & 2 == 0 { lo[1] } else { hi[1] }, if i & 4 == 0 { lo[2] } else { hi[2] }])
        .collect();
    let t = vec![[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]];
    (v, t)
}

/// Closed pieces in one mesh.
fn mesh(pieces: &[Piece]) -> Mesh {
    let (mut v, mut t) = (Vec::new(), Vec::new());
    for (pv, pt) in pieces {
        let base = v.len() as u32;
        v.extend_from_slice(pv);
        t.extend(pt.iter().map(|tri| tri.map(|i| i + base)));
    }
    Mesh::new(v, t).expect("mesh")
}

/// A ring around the z axis: `n` sides, inner and outer radius in µm, from z 0 to `h`.
fn ring(r_in: f64, r_out: f64, h: Um, n: u32) -> Piece {
    let mut v = Vec::new();
    for z in [0, h] {
        for r in [r_in, r_out] {
            for i in 0..n {
                let a = std::f64::consts::TAU * f64::from(i) / f64::from(n);
                v.push([(r * a.cos()).round() as Um, (r * a.sin()).round() as Um, z]);
            }
        }
    }
    // Ring `level` (0 bottom inner, 1 bottom outer, 2 top inner, 3 top outer), corner i.
    let at = |level: u32, i: u32| level * n + i % n;
    let mut t = Vec::new();
    for i in 0..n {
        let j = i + 1;
        t.extend([[at(1, i), at(1, j), at(3, j)], [at(1, i), at(3, j), at(3, i)]]); // outer wall
        t.extend([[at(0, i), at(2, j), at(0, j)], [at(0, i), at(2, i), at(2, j)]]); // inner wall
        t.extend([[at(2, i), at(3, i), at(3, j)], [at(2, i), at(3, j), at(2, j)]]); // top
        t.extend([[at(0, i), at(1, j), at(1, i)], [at(0, i), at(0, j), at(1, j)]]); // bottom
    }
    (v, t)
}

fn model(meshes: Vec<(&str, Mesh)>) -> PrintableModel {
    let palette = Palette::new(vec!["#808080".into()], &P2S_04).expect("palette");
    let slot = palette.slot(0).expect("slot");
    let bodies = meshes.into_iter().map(|(name, mesh)| Body { name: name.into(), slot, mesh }).collect();
    PrintableModel::new("t".into(), palette, bodies).expect("model")
}

/// The clip's measured shape: a 60 x 25 mm floor 3 mm thick and a ceiling
/// block over the jaw from z 21.4 to 26.8, with nothing between them.
fn clip_like() -> PrintableModel {
    model(vec![(
        "clip",
        mesh(&[cuboid([-30_000, 0, 0], [30_000, 25_000, 3_000]), cuboid([-30_000, 0, 21_400], [30_000, 25_000, 26_800])]),
    )])
}

fn outcome(outcomes: &[CheckOutcome], id: &str) -> CheckOutcome {
    outcomes.iter().find(|o| o.id.as_str() == id).cloned().unwrap_or_else(|| panic!("{id} was not measured"))
}

#[test]
fn the_designs_clip_spec_parses_into_typed_requirements() {
    let part = valid(clip_spec());
    assert_eq!(part.title(), "Six USB-C desk clip");
    assert_eq!(part.palette().colours(), ["#808080"], "a filament without hex prints in neutral gray");
    let ids: Vec<String> = part.requirements().iter().map(|r| r.check_id().to_string()).collect();
    assert_eq!(ids, ["geometry.requirement.0", "geometry.requirement.1"]);
    assert_eq!(
        serde_json::to_value(&part.requirements()[1].measure).expect("json"),
        json!({"measure": "opening", "axis": "z", "at_um": [0, 14_000, 12_000], "um": 18_400, "tol_um": 200})
    );
    assert_eq!(part.params_json()["cables"], json!(6), "integers stay integers for the script");
    assert_eq!(part.params_json()["clearance"], json!(0.4));
    assert_eq!(serde_json::to_value(Axis::Z).expect("json"), json!("z"), "axes are lowercase on the wire");
}

#[test]
fn a_spec_that_breaks_a_bound_is_refused_with_the_field_to_fix() {
    let with = |edit: &dyn Fn(&mut Value)| {
        let mut spec = clip_spec();
        edit(&mut spec);
        refused(spec)
    };
    type Case<'a> = (&'a dyn Fn(&mut Value), &'a str);
    let cases: [Case; 12] = [
        (&|s| s["schema_version"] = json!(2), "schema_version 2 is not supported"),
        (&|s| s["title"] = json!("  "), "title must be"),
        (&|s| s["source"] = json!("x".repeat(65 << 10)), "source must be 1 to 65536 bytes"),
        (&|s| s["params"]["bad-name"] = json!(1), "params: \"bad-name\""),
        (&|s| s["params"]["note"] = json!("x".repeat(201)), "params.note"),
        (&|s| s["params"]["nested"] = json!({"a": 1}), "did not match any variant"),
        (&|s| s["requirements"][0]["tol"] = json!(61), "requirements[0].tol"),
        (&|s| s["requirements"][1]["at"] = json!([0, 1e9, 0]), "requirements[1].at"),
        (&|s| s["requirements"][0]["mm"] = json!(-1), "requirements[0].mm"),
        (&|s| s["filaments"] = json!([{"slot": 2, "name": "Black"}]), "filaments[0].slot must be 1"),
        (&|s| s["filaments"] = json!([{"slot": 1, "name": "A"}, {"slot": 2, "name": "B"}, {"slot": 3, "name": "C"}, {"slot": 4, "name": "D"}]), "filaments: 1 to 3 slots"),
        (&|s| s["filaments"][0]["hex"] = json!("black"), "filaments[0].hex"),
    ];
    for (edit, want) in cases {
        let message = with(edit);
        assert!(message.contains(want), "{want:?} not in {message:?}");
    }
    assert!(with(&|s| s["requirements"][0]["probe"] = json!(1)).contains("unknown field"));
    assert!(with(&|s| s["requirements"][0]["axis"] = json!("X")).contains("unknown variant"));
}

/// 15 blocking checks for the one-body clip, as design.md counts them: four
/// mesh checks, two requirements, eight slice checks, and the handoff. The
/// three print checks and the support warning are advisory.
#[test]
fn the_bound_plan_gives_every_body_its_checks_and_nothing_else() {
    let part = valid(clip_spec());
    let declared = Part::check_plan(&part, &P2S_04).expect("plan");
    assert_eq!(declared.id(), PART_CHECK_PLAN);
    let bound = Part::bind_plan(&part, &P2S_04, &clip_like()).expect("bound");
    let ids: Vec<&str> = bound.required().iter().map(CheckId::as_str).collect();
    assert_eq!(
        ids,
        [
            "geometry.closed_manifold.clip", "geometry.non_degenerate.clip", "geometry.outward_orientation.clip", "geometry.bounds.clip",
            "geometry.requirement.0", "geometry.requirement.1",
            "print.overhang.clip", "print.min_wall.clip", "print.first_layer.clip",
            "slice.slice_succeeded", "slice.no_warnings", "slice.presets_applied", "slice.start_gcode_intact",
            "slice.input_unchanged", "slice.filaments_preserved", "slice.placement_preserved", "slice.layer1_coverage",
            "handoff.settings_match_slice", "slice.support_warning",
        ]
    );
    assert_eq!(bound.required().iter().filter(|id| !id.is_advisory()).count(), 15);
    assert!(declared.required().iter().all(|id| bound.required().contains(id)), "binding drops nothing");
}

#[test]
fn the_clips_requirements_are_measured_on_the_mesh() {
    let outcomes = measure_part(&valid(clip_spec()), &clip_like());
    let width = outcome(&outcomes, "geometry.requirement.0");
    assert!(width.passed, "{width:?}");
    assert_eq!(width.detail, "width 60.00 mm (60 ± 0.2)");
    let jaw = outcome(&outcomes, "geometry.requirement.1");
    assert!(jaw.passed, "{jaw:?}");
    assert_eq!(jaw.detail, "desk jaw 18.40 mm (18.4 ± 0.2)");
    for id in ["geometry.closed_manifold.clip", "geometry.non_degenerate.clip", "geometry.outward_orientation.clip", "geometry.bounds.clip"] {
        assert!(outcome(&outcomes, id).passed, "{:?}", outcome(&outcomes, id));
    }
    let plan = Part::bind_plan(&valid(clip_spec()), &P2S_04, &clip_like()).expect("plan");
    plan.certify(clip_like(), Vec::new(), outcomes).expect("the measured evidence matches the bound plan");
}

/// The ceiling floats over the jaw with nothing below it: the overhang check
/// warns, and the warning does not stop the model from being certified.
#[test]
fn an_overhang_is_a_print_warning_not_a_failure() {
    let part = valid(clip_spec());
    let outcomes = measure_part(&part, &clip_like());
    let overhang = outcome(&outcomes, "print.overhang.clip");
    assert!(!overhang.passed, "{overhang:?}");
    assert!(overhang.detail.starts_with("about 1500 mm² unsupported at z 21.4 mm"), "{}", overhang.detail);
    let plan = Part::bind_plan(&part, &P2S_04, &clip_like()).expect("plan");
    let checked = plan.certify(clip_like(), Vec::new(), outcomes).expect("certified");
    let warnings: Vec<&str> = checked.geometry().warnings().map(CheckId::as_str).collect();
    assert_eq!(warnings, ["print.overhang.clip"]);
}

#[test]
fn a_missed_requirement_fails_its_check_with_the_measured_value() {
    let mut spec = clip_spec();
    spec["requirements"][1]["mm"] = json!(20);
    let jaw = outcome(&measure_part(&valid(spec), &clip_like()), "geometry.requirement.1");
    assert!(!jaw.passed);
    assert_eq!(jaw.detail, "desk jaw 18.40 mm (20 ± 0.2)");

    let mut inside = clip_spec();
    inside["requirements"][1]["at"] = json!([0, 14, 1]);
    let probe = outcome(&measure_part(&valid(inside), &clip_like()), "geometry.requirement.1");
    assert!(!probe.passed);
    assert_eq!(probe.detail, "desk jaw: the point [0, 14, 1] is inside material, not in the gap");

    let mut open = clip_spec();
    open["requirements"][1]["at"] = json!([0, 14, 30]);
    let probe = outcome(&measure_part(&valid(open), &clip_like()), "geometry.requirement.1");
    assert!(!probe.passed && probe.detail.contains("no material closes the gap along z"), "{probe:?}");
}

#[test]
fn a_hole_is_measured_by_its_fitted_circle_and_a_wall_by_its_thinnest_chord() {
    let mut spec = clip_spec();
    spec["requirements"] = json!([
        {"measure": "hole", "name": "bore", "axis": "z", "at": [0, 0, 5], "mm": 8, "tol": 0.05},
        {"measure": "min_wall", "name": "ring wall", "at": [5, 0, 5], "mm": 1.9},
        {"measure": "min_wall", "name": "too thin", "at": [5, 0, 5], "mm": 2.5},
        {"measure": "hole", "name": "solid", "axis": "z", "at": [5, 0, 5], "mm": 8, "tol": 0.05}
    ]);
    let ringed = model(vec![("ring", mesh(&[ring(4_000.0, 6_000.0, 10_000, 128)]))]);
    let outcomes = measure_part(&valid(spec), &ringed);
    assert!(outcome(&outcomes, "geometry.closed_manifold.ring").passed, "the test ring is a closed solid");
    let bore = outcome(&outcomes, "geometry.requirement.0");
    assert!(bore.passed, "{bore:?}");
    assert!(bore.detail.starts_with("bore 8.00 mm"), "{}", bore.detail);
    let wall = outcome(&outcomes, "geometry.requirement.1");
    assert!(wall.passed, "{wall:?}");
    assert!(wall.detail.starts_with("ring wall 2.00 mm"), "{}", wall.detail);
    assert!(!outcome(&outcomes, "geometry.requirement.2").passed);
    let solid = outcome(&outcomes, "geometry.requirement.3");
    assert!(!solid.passed && solid.detail.contains("inside material"), "{solid:?}");
}

#[test]
fn a_part_off_the_bed_or_too_big_fails_its_bounds() {
    let part = valid(clip_spec());
    let bounds = |pieces: &[Piece]| outcome(&measure_part(&part, &model(vec![("clip", mesh(pieces))])), "geometry.bounds.clip");
    let floating = bounds(&[cuboid([0, 0, 1_000], [10_000, 10_000, 5_000])]);
    assert!(!floating.passed && floating.detail.contains("not on the bed"), "{floating:?}");
    let sunk = bounds(&[cuboid([0, 0, -4_400], [10_000, 10_000, 5_000])]);
    assert!(!sunk.passed && sunk.detail.contains("below the bed"), "{sunk:?}");
    let huge = bounds(&[cuboid([0, 0, 0], [300_000, 10_000, 5_000])]);
    assert!(!huge.passed && huge.detail.contains("does not fit"), "{huge:?}");
}

/// What a script says about itself never reaches the checks: an open mesh
/// fails `closed_manifold` whatever the body is called, and the plan admits no
/// check the kind did not name.
#[test]
fn only_the_mesh_decides_the_checks() {
    let part = valid(clip_spec());
    let (v, mut t) = cuboid([0, 0, 0], [10_000, 10_000, 5_000]);
    t.pop();
    let open = model(vec![("all checks passed", Mesh::new(v, t).expect("mesh"))]);
    let outcomes = measure_part(&part, &open);
    assert!(!outcome(&outcomes, "geometry.closed_manifold.all checks passed").passed);
    let plan = Part::bind_plan(&part, &P2S_04, &open).expect("plan");
    let mut forged = outcomes.clone();
    forged.iter_mut().for_each(|o| o.passed = true);
    forged.push(CheckOutcome { id: CheckId::new(CheckPhase::Geometry, "script_says_ok.clip"), passed: true, detail: "ok".into() });
    assert!(plan.certify(open.clone(), Vec::new(), forged).is_err(), "a check the kind did not name is refused");
    assert!(plan.certify(open, Vec::new(), outcomes).is_err(), "the open mesh fails");
}

#[test]
fn without_a_runtime_a_part_is_unavailable_and_never_runs() {
    let ctx = KernelContext::without_runtime(P2S_04);
    let driver = Kind::<Part>::NEW;
    assert!(!driver.available(&ctx));
    let parsed = driver.parse(clip_spec(), &P2S_04).expect("parses without a runtime");
    let control = BuildControl::new(&|_| {}, &|| false);
    let err = driver.prepare(&parsed, &ctx, &control).err().expect("no runtime, no build");
    assert_eq!(err.to_string(), "build failed: the CAD runtime is unavailable");
}

#[test]
fn the_views_draw_the_model_from_three_sides() {
    let views = Part::preview(&valid(clip_spec()), &clip_like()).expect("views");
    let names: Vec<View> = views.views().iter().map(|(view, _)| *view).collect();
    assert_eq!(names, [View::Isometric, View::Front, View::Top]);
    for (view, png) in views.views() {
        assert_eq!(&png[1..4], b"PNG", "{view:?}");
    }
    assert_eq!(views.preview(), views.views()[0].1, "the isometric view is the preview");
    assert_ne!(views.views()[1].1, views.views()[2].1, "front and top differ");
}

/// A part with a print warning verifies; approving it takes exactly that
/// warning, and any other acknowledged set is refused.
#[test]
fn approval_refuses_an_acknowledgement_that_differs_from_the_warnings() {
    use crate::fabrication::revisions::{self, Actor, Approval, BuildFiles, Claim, NewRevision, RevisionError, Sha256Hex, SlicerIdentity};
    use std::collections::BTreeSet;

    let part = valid(clip_spec());
    let plan = Part::bind_plan(&part, &P2S_04, &clip_like()).expect("plan");
    let checked = plan.certify(clip_like(), Vec::new(), measure_part(&part, &clip_like())).expect("certified");
    let slice: Vec<CheckOutcome> = plan
        .required()
        .iter()
        .filter(|id| id.phase() == CheckPhase::Slice)
        .map(|id| CheckOutcome { id: id.clone(), passed: true, detail: "ok".into() })
        .collect();
    let handoff = vec![CheckOutcome { id: handoff_settings_match_slice(), passed: true, detail: "ok".into() }];
    let passed = plan.finish(checked.geometry(), slice, handoff).expect("verified with a warning");

    let dir = tempfile::tempdir().expect("tempdir");
    let mut conn = rusqlite::Connection::open_in_memory().expect("db");
    conn.execute_batch(revisions::MIGRATION_004).expect("004");
    let tx = conn.transaction().expect("tx");
    tx.execute_batch(revisions::MIGRATION_006).expect("006");
    tx.commit().expect("commit");
    let request = NewRevision {
        lineage_id: None,
        kind: Part::ID,
        title: part.title().into(),
        spec: clip_spec(),
        spec_sha256: Sha256Hex::of_bytes(b"spec"),
        build_key: Sha256Hex::of_bytes(b"key"),
        check_plan: PART_CHECK_PLAN,
        requested_by: Actor::Agent,
    };
    let Claim::Started(revision) = revisions::claim(&mut conn, &request).expect("claim") else { panic!("expected a new build") };
    let package = dir.path().join("part.3mf");
    std::fs::write(&package, b"package").expect("package");
    let files = BuildFiles {
        revision_dir: dir.path().into(),
        package_path: package,
        package_sha256: Sha256Hex::of_bytes(b"package"),
        preview_path: dir.path().join("preview.png"),
        slice_dir: dir.path().join("slice"),
        gcode_sha256: Sha256Hex::of_bytes(b"gcode"),
        slicer: SlicerIdentity { name: "Bambu Studio".into(), version: "02.08.02.61".into(), profile_version: "02.08.00.05".into() },
        effective_settings: Value::Null,
        size_mm: None,
    };
    revisions::finish_verified(&conn, &revision.build_id, files, &passed).expect("verified");

    let hash = Sha256Hex::of_bytes(b"package");
    let overhang = CheckId::try_from("print.overhang.clip".to_owned()).expect("id");
    let other = CheckId::try_from("print.min_wall.clip".to_owned()).expect("id");
    for acknowledged in [BTreeSet::new(), BTreeSet::from([other.clone()]), BTreeSet::from([overhang.clone(), other])] {
        let refused = revisions::approve(&mut conn, &revision.id, &hash, &acknowledged, Actor::Human);
        assert!(matches!(refused, Err(RevisionError::WarningsMismatch { .. })), "{acknowledged:?}: {refused:?}");
    }
    let approved = revisions::approve(&mut conn, &revision.id, &hash, &BTreeSet::from([overhang]), Actor::Human).expect("approve");
    assert!(matches!(approved.approval, Approval::Approved { .. }));
}


/// A wall `t` thick, 20 mm long and 10 mm tall, turned `degrees` about z,
/// standing on the bed and centered on the z axis.
fn rotated_wall(t_um: f64, degrees: f64) -> Mesh {
    let (sin, cos) = degrees.to_radians().sin_cos();
    let (v, t) = cuboid([-10_000, 0, 0], [10_000, 1, 10_000]);
    let v = v
        .into_iter()
        .map(|[x, y, z]| {
            let y = if y == 0 { -t_um / 2.0 } else { t_um / 2.0 };
            let x = x as f64;
            [(x * cos - y * sin).round() as Um, (x * sin + y * cos).round() as Um, z]
        })
        .collect();
    Mesh::new(v, t).expect("mesh")
}

/// A wall thinner than the requirement fails at every angle, and one thicker
/// passes, with the probe at the wall's middle or off to one side. The
/// measurement never reports more than the wall's real thickness.
#[test]
fn a_rotated_wall_is_never_measured_thicker_than_it_is() {
    let requirement = |at: [f64; 3]| {
        let mut spec = clip_spec();
        spec["requirements"] = json!([{ "measure": "min_wall", "name": "wall", "at": at, "mm": 1.0 }]);
        valid(spec)
    };
    for degrees in [0.0, 10.0, 22.5, 30.0, 45.0, 60.0, 67.5, 89.0] {
        let thin = model(vec![("wall", rotated_wall(950.0, degrees))]);
        let measured = outcome(&measure_part(&requirement([0.0, 0.0, 5.0]), &thin), "geometry.requirement.0");
        assert!(!measured.passed, "{degrees} degrees: {measured:?}");
        let reported: f64 = measured.detail.split_whitespace().nth(1).and_then(|v| v.parse().ok()).expect("a number");
        assert!(reported <= 0.95 + 0.005, "{degrees} degrees: {}", measured.detail);

        let thick = model(vec![("wall", rotated_wall(1_050.0, degrees))]);
        let (sin, cos) = degrees.to_radians().sin_cos();
        for off in [0.0, 0.3] {
            let at = [-off * sin, off * cos, 5.0];
            let measured = outcome(&measure_part(&requirement(at), &thick), "geometry.requirement.0");
            assert!(measured.passed, "{degrees} degrees, {off} mm off the middle: {measured:?}");
        }
    }
}

/// A part the printer cannot hold fails its bounds, and nothing is sliced:
/// its print checks say so instead of holding thousands of layers.
#[test]
fn a_part_too_big_for_the_printer_is_not_sliced() {
    let huge = model(vec![("clip", mesh(&[cuboid([-1_000_000, -1_000_000, 0], [1_000_000, 1_000_000, 2_000_000])]))]);
    let started = std::time::Instant::now();
    let outcomes = measure_part(&valid(clip_spec()), &huge);
    assert!(!outcome(&outcomes, "geometry.bounds.clip").passed);
    for id in ["print.overhang.clip", "print.min_wall.clip", "print.first_layer.clip"] {
        assert_eq!(outcome(&outcomes, id).detail, "not measured: the part does not fit the printer", "{id}");
    }
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
}

/// A probe outside the material never gets a wall reading: in the void
/// between two bodies, in the gap of a U, or where every axis ray from it
/// runs through shared edges.
#[test]
fn a_probe_outside_the_material_never_gets_a_wall_reading() {
    let wall_at = |at: [f64; 3]| {
        let mut spec = clip_spec();
        spec["requirements"] = json!([{ "measure": "min_wall", "name": "wall", "at": at, "mm": 0.5 }]);
        valid(spec)
    };
    let not_material = |m: &PrintableModel, at: [f64; 3]| {
        let measured = outcome(&measure_part(&wall_at(at), m), "geometry.requirement.0");
        assert!(!measured.passed, "{at:?}: {measured:?}");
        assert!(measured.detail.ends_with("is not inside material"), "{at:?}: {}", measured.detail);
    };
    // Two bodies with a 0.6 mm gap between them.
    let apart = model(vec![
        ("left", mesh(&[cuboid([-10_000, -10_000, 0], [-300, 10_000, 10_000])])),
        ("right", mesh(&[cuboid([300, -10_000, 0], [10_000, 10_000, 10_000])])),
    ]);
    not_material(&apart, [0.0, 0.0, 5.0]);
    // The gap of a U: a base and two arms in one body.
    let u = model(vec![(
        "u",
        mesh(&[
            cuboid([-10_000, -5_000, 0], [10_000, 5_000, 2_000]),
            cuboid([-10_000, -5_000, 2_000], [-300, 5_000, 10_000]),
            cuboid([300, -5_000, 2_000], [10_000, 5_000, 10_000]),
        ]),
    )]);
    not_material(&u, [0.0, 0.0, 5.0]);
    // Outside a single box, level with its edges and corners on every axis.
    let boxed = model(vec![("box", mesh(&[cuboid([0, 0, 0], [10_000, 10_000, 10_000])]))]);
    not_material(&boxed, [-5.0, 5.0, 5.0]);
    not_material(&boxed, [15.0, 10.0, 10.0]);
}

/// A mesh with more triangles than the layer checks slice fails at
/// inspection, so no part verifies without its print checks.
#[test]
fn a_mesh_over_the_slicing_limit_fails_at_inspect() {
    use crate::fabrication::cad_worker::{decode_mesh, MeshLimits};
    let mesh = |triangles: u32| {
        let mut bytes = b"M3DMESH1".to_vec();
        bytes.extend(1u32.to_le_bytes());
        bytes.extend(3u32.to_le_bytes());
        bytes.extend(triangles.to_le_bytes());
        [[0.0f64, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]].iter().flatten().for_each(|c| bytes.extend(c.to_le_bytes()));
        (0..triangles).for_each(|_| [0u32, 1, 2].iter().for_each(|i| bytes.extend(i.to_le_bytes())));
        decode_mesh(&bytes, &MeshLimits::PART).expect("within the decoder's limits")
    };
    within_slicing_limit(&mesh(1_000_000)).expect("at the limit");
    let err = within_slicing_limit(&mesh(1_000_001)).expect_err("over the limit");
    assert_eq!(err.to_string(), "inspect: the solid tessellates into 1000001 triangles; at most 1000000 are allowed, so simplify the model");
}

/// `Part::measure` under a build that is never cancelled.
fn measure_part(part: &ValidPart, model: &PrintableModel) -> Vec<CheckOutcome> {
    Part::measure(part, model, &BuildControl::new(&|_| {}, &|| false)).expect("measured")
}

#[test]
fn a_cancelled_build_stops_measuring_with_cancelled() {
    let stopped = Part::measure(&valid(clip_spec()), &clip_like(), &BuildControl::new(&|_| {}, &|| true));
    assert!(matches!(stopped, Err(KernelError::Cancelled)), "{stopped:?}");
}
