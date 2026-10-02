use std::io::Read;

use serde_json::{json, Value};

use super::geometry::{build_model_with, Dims, Shapes, P};
use super::mesh::area2;
use super::*;
use crate::fabrication::kind::{Kind, KindDriver};
use crate::fabrication::model::PrintableModel;
use crate::fabrication::package::{write_package, PackageError, PackageInfo};
use crate::fabrication::printer::P2S_04;

const FIXTURE: &str = include_str!("../../../../tests/fixtures/signs/synthetic-back-shortly.json");

fn design(json: &str) -> SignDesign {
    SignDesign::new(ValidSignSpec::from_json(json, &P2S_04).expect("spec validates")).expect("layout")
}

fn fixture() -> SignDesign {
    design(FIXTURE)
}

fn model_of(design: &SignDesign) -> PrintableModel {
    build_model(design.layout(), design.spec().title(), &P2S_04).unwrap()
}

/// Certifies the sign's model against its check plan and writes its package,
/// as the build pipeline does, with the title as the 3MF object name.
fn package(design: &SignDesign, out: &std::path::Path) -> Result<PackageInfo, PackageError> {
    let model = model_of(design);
    let evidence = check_geometry(design.layout(), &model).iter().map(GeometryCheck::outcome).collect();
    let checked = check_plan(design.spec()).unwrap().certify(model, evidence).unwrap();
    write_package(&checked, design.spec().title(), &P2S_04, out)
}

fn failed(checks: &[GeometryCheck]) -> Vec<String> {
    checks
        .iter()
        .filter(|c| !c.passed)
        .map(|c| format!("{} [{}]: {}", c.name, c.subject, c.detail))
        .collect()
}

fn area_mm2(shapes: &Shapes) -> f64 {
    shapes.iter().flatten().map(|r| area2(r)).sum::<i64>() as f64 / 2.0 / 1e6
}

/// Fixture JSON with `edit` applied to its object tree.
fn fixture_with(edit: impl FnOnce(&mut Value)) -> Result<ValidSignSpec, SpecError> {
    let mut value: Value = serde_json::from_str(FIXTURE).unwrap();
    edit(&mut value);
    ValidSignSpec::from_json(&value.to_string(), &P2S_04)
}

#[test]
fn fixture_geometry_passes_every_check() {
    let design = fixture();
    let model = model_of(&design);
    let checks = check_geometry(design.layout(), &model);
    assert_eq!(failed(&checks), Vec::<String>::new());
    let names: Vec<_> = model
        .bodies()
        .iter()
        .map(|b| (b.name.as_str(), b.slot.number()))
        .collect();
    assert_eq!(names, [("white", 1), ("navy", 2), ("teal", 3)]);
    for name in [
        "closed_manifold",
        "outward_orientation",
        "area_partition",
        "orientation_oracle",
    ] {
        assert!(
            checks.iter().any(|c| c.name == name),
            "missing check {name}"
        );
    }
}

#[test]
fn the_acceptance_sign_passes_every_geometry_check() {
    let design = design(include_str!("../../../../../docs/acceptance/p2s-test-sign.json"));
    assert_eq!(failed(&check_geometry(design.layout(), &model_of(&design))), Vec::<String>::new());
    if let Some(out) = std::env::var_os("ACCEPTANCE_PREVIEW_OUT") {
        std::fs::write(out, render_preview(design.layout(), 10.0).expect("preview")).expect("write preview");
    }
}

#[test]
fn rejects_unknown_field() {
    let err = fixture_with(|v| v["colour"] = json!("red")).unwrap_err();
    assert!(matches!(err, SpecError::Json(_)), "{err}");
    let err = fixture_with(|v| v["elements"][2]["depth_mm"] = json!(1)).unwrap_err();
    assert!(matches!(err, SpecError::Json(_)), "{err}");
}

#[test]
fn rejects_unmapped_svg_color() {
    let err = fixture_with(|v| {
        v["elements"][0]["ink_map"] = json!({ "#1f3a5f": "navy" });
    })
    .unwrap_err();
    assert!(
        matches!(&err, SpecError::UnmappedSvgColor { element: 0, color } if color == "#1a9e96"),
        "{err}"
    );
}

#[test]
fn rejects_svg_strokes() {
    let err = fixture_with(|v| {
        v["elements"][0]["svg_source"] = json!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#1F3A5F" stroke="#1A9E96" d="M1 1H9V9Z"/></svg>"##
        );
    })
    .unwrap_err();
    assert!(matches!(err, SpecError::SvgStroke { element: 0 }), "{err}");
}

/// usvg drops an `<image>` it cannot resolve without an error, so a sign with
/// fills beside such an image would build with the art silently missing.
#[test]
fn rejects_svg_images_even_when_usvg_would_drop_them() {
    for image in [
        r#"<image href="missing.png" width="4" height="4"/>"#,
        r#"<image href="data:image/png;base64,not-base64!" width="4" height="4"/>"#,
    ] {
        let err = fixture_with(|v| {
            v["elements"][0]["svg_source"] = json!(format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#1F3A5F" d="M1 1H9V9Z"/>{image}</svg>"##
            ));
        })
        .unwrap_err();
        assert!(
            matches!(&err, SpecError::Svg { element: 0, reason } if reason.contains("<image>")),
            "{image}: {err}"
        );
    }
}

#[test]
fn rejects_too_many_inks() {
    let err = fixture_with(|v| {
        v["inks"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "name": "red", "hex": "#FF0000" }));
    })
    .unwrap_err();
    assert!(matches!(err, SpecError::InkCount(3)), "{err}");
}

#[test]
fn rejects_bad_hex() {
    for hex in ["#12345", "123456", "#12345G", "#1234567"] {
        let err = fixture_with(|v| v["inks"][0]["hex"] = json!(hex)).unwrap_err();
        assert!(
            matches!(&err, SpecError::BadHex { name, .. } if name == "navy"),
            "{hex}: {err}"
        );
    }
}

/// The hash the build key is made from, through the kind as the pipeline parses it.
fn spec_hash(json: &str) -> String {
    Kind::<Sign>::NEW.parse(serde_json::from_str(json).unwrap(), &P2S_04).unwrap().spec_sha256().to_string()
}

#[test]
fn spec_hash_is_stable_across_field_order() {
    /// JSON text with every object's keys in reverse order.
    fn reversed(value: &Value) -> String {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let fields: Vec<String> = keys
                    .into_iter()
                    .rev()
                    .map(|k| format!("{}:{}", Value::String(k.clone()), reversed(&map[k])))
                    .collect();
                format!("{{{}}}", fields.join(","))
            }
            Value::Array(items) => {
                format!(
                    "[{}]",
                    items.iter().map(reversed).collect::<Vec<_>>().join(",")
                )
            }
            scalar => scalar.to_string(),
        }
    }
    let reversed_json = reversed(&serde_json::from_str(FIXTURE).unwrap());
    assert!(
        reversed_json.starts_with(r#"{"width_mm":150"#),
        "{reversed_json:.40}"
    );
    assert_eq!(spec_hash(FIXTURE), spec_hash(&reversed_json));

    let mut changed: Value = serde_json::from_str(FIXTURE).unwrap();
    changed["elements"][1]["text"] = json!("BACK SOON");
    assert_ne!(spec_hash(FIXTURE), spec_hash(&changed.to_string()));
}

/// Sign build keys join the kind's tag and the spec hash. Both must stay what
/// they were before kinds existed, or no pre-kind sign build would be reused.
#[test]
fn sign_spec_hashes_and_tag_match_the_characterization_fixture() {
    let expected: Value = serde_json::from_str(CHARACTERIZATION).unwrap();
    for (name, json) in [
        ("synthetic-back-shortly", FIXTURE),
        ("p2s-test-sign", include_str!("../../../../../docs/acceptance/p2s-test-sign.json")),
        ("synthetic-one-ink", include_str!("../../../../tests/fixtures/signs/synthetic-one-ink.json")),
    ] {
        assert_eq!(spec_hash(json), expected["packages"][name]["spec_sha256"], "{name} spec hash");
    }
    let parsed = Kind::<Sign>::NEW.parse(serde_json::from_str(FIXTURE).unwrap(), &P2S_04).unwrap();
    assert_eq!(parsed.tag(), "sign-pipeline-1");
    assert_eq!(parsed.kind().as_str(), "sign");
}

/// The edge limit is the bed of the printer the spec is validated for.
#[test]
fn a_sign_edge_may_not_exceed_the_printers_bed() {
    let wide = |width: f64| {
        let mut value: Value = serde_json::from_str(FIXTURE).unwrap();
        value["width_mm"] = json!(width);
        value.to_string()
    };
    let small = crate::fabrication::printer::PrinterProfile { bed: [100_000, 256_000, 256_000], ..P2S_04 };
    assert!(ValidSignSpec::from_json(&wide(150.0), &P2S_04).is_ok());
    let err = ValidSignSpec::from_json(&wide(150.0), &small).unwrap_err();
    assert_eq!(err.to_string(), "width_mm: 150 mm exceeds the 100 mm bed");
    let err = ValidSignSpec::from_json(&wide(257.0), &P2S_04).unwrap_err();
    assert_eq!(err.to_string(), "width_mm: 257 mm exceeds the 256 mm bed");
}

#[test]
fn package_is_deterministic_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let infos: Vec<PackageInfo> = ["a.3mf", "b.3mf"]
        .iter()
        .map(|name| package(&fixture(), &dir.path().join(name)).unwrap())
        .collect();
    assert_eq!(infos[0], infos[1]);
    assert_eq!(infos[0].part_names, ["white", "navy", "teal"]);
    let a = std::fs::read(dir.path().join("a.3mf")).unwrap();
    assert_eq!(a, std::fs::read(dir.path().join("b.3mf")).unwrap());

    let err = package(&fixture(), &dir.path().join("a.3mf")).unwrap_err();
    assert!(
        matches!(&err, PackageError::Io(e) if e.kind() == std::io::ErrorKind::AlreadyExists),
        "{err}"
    );
    assert_eq!(std::fs::read(dir.path().join("a.3mf")).unwrap(), a);
    let leftovers = std::fs::read_dir(dir.path()).unwrap().count();
    assert_eq!(leftovers, 2, "temporary files left behind");

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(a)).unwrap();
    let names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    assert_eq!(
        names,
        [
            "[Content_Types].xml",
            "_rels/.rels",
            "3D/3dmodel.model",
            "Metadata/model_settings.config",
            "Metadata/project_settings.config"
        ]
    );
    let mut settings = String::new();
    zip.by_name("Metadata/project_settings.config")
        .unwrap()
        .read_to_string(&mut settings)
        .unwrap();
    let settings: Value = serde_json::from_str(&settings).unwrap();
    let colours = json!(["#FFFFFF", "#1F3A5F", "#1A9E96"]);
    assert_eq!(settings["filament_colour"], colours);
    assert_eq!(settings["filament_multi_colour"], colours);
    let mut model_settings = String::new();
    zip.by_name("Metadata/model_settings.config")
        .unwrap()
        .read_to_string(&mut model_settings)
        .unwrap();
    for (id, name, extruder) in [(1, "white", 1), (2, "navy", 2), (3, "teal", 3)] {
        let part = format!(
            r#"<part id="{id}" subtype="normal_part"><metadata key="name" value="{name}" /><metadata key="extruder" value="{extruder}" />"#
        );
        assert!(model_settings.contains(&part), "missing {part}");
    }
}

#[test]
fn orientation_oracle_rejects_an_unmirrored_face() {
    // Upright when seen from above, so mirrored when the bed face is read from below.
    fn wrong(p: P, dims: Dims) -> P {
        P::new(p.x, dims.h - p.y)
    }
    let design = fixture();
    let mirrored = build_model_with(design.layout(), design.spec().title(), &P2S_04, wrong).unwrap();
    let checks = check_geometry(design.layout(), &mirrored);
    let failures = failed(&checks);
    assert!(!failures.is_empty());
    assert!(
        failures.iter().all(|f| f.starts_with("orientation_oracle")),
        "only the oracle should notice: {failures:?}"
    );
    for ink in ["navy", "teal"] {
        assert!(
            failures.iter().any(|f| f.contains(&format!("[{ink}]"))),
            "{failures:?}"
        );
    }
}

#[test]
fn base_paint_knocks_out_and_later_ink_paints_over() {
    let design = design(
        &json!({
            "schema_version": 1,
            "width_mm": 100, "height_mm": 60,
            "base": { "name": "white", "hex": "#ffffff" },
            "inks": [{ "name": "navy", "hex": "#1F3A5F" }, { "name": "teal", "hex": "#1A9E96" }],
            "elements": [
                { "type": "rect", "ink": "navy", "x_mm": 10, "y_mm": 10, "w_mm": 40, "h_mm": 40 },
                { "type": "rect", "ink": "teal", "x_mm": 40, "y_mm": 10, "w_mm": 30, "h_mm": 40 },
                { "type": "rect", "ink": "white", "x_mm": 20, "y_mm": 20, "w_mm": 10, "h_mm": 10 },
                { "type": "rect", "ink": "navy", "x_mm": 80, "y_mm": 10, "w_mm": 10, "h_mm": 10 }
            ]
        })
        .to_string(),
    );
    assert_eq!(failed(&check_geometry(design.layout(), &model_of(&design))), Vec::<String>::new());
    let [base, navy, teal] = [0, 1, 2].map(|i| area_mm2(&design.layout().face[i]));
    // Navy: 40x40 minus the teal overlap (10x40) minus the knockout (10x10), plus 10x10.
    assert!(
        (navy - (1600.0 - 400.0 - 100.0 + 100.0)).abs() < 1e-6,
        "navy {navy}"
    );
    assert!((teal - 1200.0).abs() < 1e-6, "teal {teal}");
    assert!(
        (base - (6000.0 - 1200.0 - 1200.0)).abs() < 1e-6,
        "base {base}"
    );
}

/// Writes the fixture package and preview for manual slicing:
/// `SIGN_FIXTURE_OUT=/some/dir cargo test --lib write_fixture_artifacts -- --ignored`
#[test]
#[ignore = "writes artifacts for manual slicing"]
fn write_fixture_artifacts() {
    let out =
        std::path::PathBuf::from(std::env::var("SIGN_FIXTURE_OUT").expect("set SIGN_FIXTURE_OUT"));
    std::fs::create_dir_all(&out).unwrap();
    let design = fixture();
    let model = model_of(&design);
    let checks = check_geometry(design.layout(), &model);
    std::fs::write(
        out.join("checks.json"),
        serde_json::to_vec_pretty(&checks).unwrap(),
    )
    .unwrap();
    std::fs::write(
        out.join("preview.png"),
        render_preview(design.layout(), 5.0).unwrap(),
    )
    .unwrap();
    let triangles: Vec<(String, usize)> = model
        .bodies()
        .iter()
        .map(|b| (b.name.clone(), b.mesh.triangles().len()))
        .collect();
    let info = package(&design, &out.join("synthetic-back-shortly.3mf")).unwrap();
    let summary = json!({
        "spec_hash": spec_hash(FIXTURE),
        "package": info,
        "triangles": triangles,
    });
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
    println!("{summary:#}");
}


/// Package hashes captured from `canonical/main` before signs moved onto the
/// shared printable model. Any change to sign package bytes fails here.
const CHARACTERIZATION: &str = include_str!("../../../../tests/fixtures/signs/characterization.json");

#[test]
fn sign_packages_match_the_characterization_fixture() {
    let expected: Value = serde_json::from_str(CHARACTERIZATION).unwrap();
    let dir = tempfile::tempdir().unwrap();
    for (name, json) in [
        ("synthetic-back-shortly", FIXTURE),
        ("p2s-test-sign", include_str!("../../../../../docs/acceptance/p2s-test-sign.json")),
        ("synthetic-one-ink", include_str!("../../../../tests/fixtures/signs/synthetic-one-ink.json")),
    ] {
        let info = package(&design(json), &dir.path().join(format!("{name}.3mf"))).unwrap();
        let want = &expected["packages"][name];
        assert_eq!(info.sha256, want["sha256"], "{name} package sha256");
        assert_eq!(info.bytes, want["bytes"], "{name} package size");
    }
}

#[test]
fn the_sign_check_plan_names_the_characterized_checks_in_recorded_order() {
    let expected: Value = serde_json::from_str(CHARACTERIZATION).unwrap();
    let want: Vec<&str> = expected["synthetic_back_shortly_check_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(want.len(), 27);
    let design = fixture();
    let plan = check_plan(design.spec()).unwrap();
    let ids: Vec<&str> = plan.required().iter().map(|id| id.as_str()).collect();
    assert_eq!(ids, want);
    assert_eq!(plan.id(), SIGN_CHECK_PLAN);

    let measured: Vec<String> = check_geometry(design.layout(), &model_of(&design)).iter().map(|c| c.id().to_string()).collect();
    assert_eq!(measured, want[..18], "the geometry checks measured are the ones planned, in order");
}
