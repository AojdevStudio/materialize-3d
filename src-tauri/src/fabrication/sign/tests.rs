use std::io::Read;

use serde_json::{json, Value};

use super::geometry::{build_geometry_with, Dims, Shapes, P};
use super::mesh::area2;
use super::*;

const FIXTURE: &str = include_str!("../../../tests/fixtures/signs/synthetic-back-shortly.json");

fn fixture() -> ValidSignSpec {
    ValidSignSpec::from_json(FIXTURE).expect("fixture validates")
}

fn template() -> Value {
    serde_json::from_str(P2S_PROJECT_SETTINGS_TEMPLATE).expect("template parses")
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
    ValidSignSpec::from_json(&value.to_string())
}

#[test]
fn fixture_geometry_passes_every_check() {
    let geometry = build_geometry(&fixture()).unwrap();
    let checks = check_geometry(&geometry);
    assert_eq!(failed(&checks), Vec::<String>::new());
    let names: Vec<_> = geometry
        .bodies
        .iter()
        .map(|b| (b.name.as_str(), b.extruder))
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
    let original = fixture();
    let reversed_json = reversed(&serde_json::from_str(FIXTURE).unwrap());
    assert!(
        reversed_json.starts_with(r#"{"width_mm":150"#),
        "{reversed_json:.40}"
    );
    let reordered = ValidSignSpec::from_json(&reversed_json).unwrap();
    assert_eq!(spec_hash(&original), spec_hash(&reordered));

    let changed = fixture_with(|v| v["elements"][1]["text"] = json!("BACK SOON")).unwrap();
    assert_ne!(spec_hash(&original), spec_hash(&changed));
}

#[test]
fn package_is_deterministic_and_never_overwrites() {
    let dir = tempfile::tempdir().unwrap();
    let infos: Vec<PackageInfo> = ["a.3mf", "b.3mf"]
        .iter()
        .map(|name| {
            let spec = fixture();
            let geometry = build_geometry(&spec).unwrap();
            write_package(&geometry, &spec, &template(), &dir.path().join(name)).unwrap()
        })
        .collect();
    assert_eq!(infos[0], infos[1]);
    assert_eq!(infos[0].part_names, ["white", "navy", "teal"]);
    let a = std::fs::read(dir.path().join("a.3mf")).unwrap();
    assert_eq!(a, std::fs::read(dir.path().join("b.3mf")).unwrap());

    let spec = fixture();
    let geometry = build_geometry(&spec).unwrap();
    let err = write_package(&geometry, &spec, &template(), &dir.path().join("a.3mf")).unwrap_err();
    assert!(
        matches!(&err, SignError::Io(e) if e.kind() == std::io::ErrorKind::AlreadyExists),
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
    let checks = check_geometry(&build_geometry_with(&fixture(), wrong).unwrap());
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
    let spec = ValidSignSpec::from_json(
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
    )
    .unwrap();
    let geometry = build_geometry(&spec).unwrap();
    assert_eq!(failed(&check_geometry(&geometry)), Vec::<String>::new());
    let [base, navy, teal] = [0, 1, 2].map(|i| area_mm2(&geometry.face[i]));
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
    let spec = fixture();
    let geometry = build_geometry(&spec).unwrap();
    let checks = check_geometry(&geometry);
    std::fs::write(
        out.join("checks.json"),
        serde_json::to_vec_pretty(&checks).unwrap(),
    )
    .unwrap();
    std::fs::write(
        out.join("preview.png"),
        render_preview(&geometry, 5.0).unwrap(),
    )
    .unwrap();
    let info = write_package(
        &geometry,
        &spec,
        &template(),
        &out.join("synthetic-back-shortly.3mf"),
    )
    .unwrap();
    let summary = json!({
        "spec_hash": spec_hash(&spec),
        "package": info,
        "triangles": geometry.bodies.iter().map(|b| (b.name.clone(), b.triangles().len())).collect::<Vec<_>>(),
    });
    std::fs::write(
        out.join("summary.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
    println!("{summary:#}");
}
