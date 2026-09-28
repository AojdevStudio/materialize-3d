//! Real-binary proof of the proven slice. Needs a validated Bambu Studio and the private
//! proven package, neither of which lives in the repo:
//!
//! ```sh
//! BAMBU_STUDIO_CLI=/path/to/BambuStudio M3D_PROVEN_3MF=/path/to/package.3mf \
//!   cargo test --lib fabrication::bambu::integration_tests -- --ignored --nocapture
//! ```

use std::fs;
use std::io::BufReader;
use std::path::PathBuf;

use super::*;

/// Slices the proven package into a scratch dir that lives as long as the returned guard.
fn slice_proven() -> (
    tempfile::TempDir,
    SliceReport,
    Vec<PartFootprint>,
    ResolvedPresets,
) {
    let package = PathBuf::from(std::env::var_os("M3D_PROVEN_3MF").expect("M3D_PROVEN_3MF is set"));
    assert!(
        std::env::var_os("BAMBU_STUDIO_CLI").is_some(),
        "BAMBU_STUDIO_CLI is set"
    );
    let studio = BambuStudio::locate().expect("validated Bambu Studio");
    println!("studio: {} ({})", studio.exe.display(), studio.version);

    let scratch = tempfile::tempdir().expect("tempdir");
    let selection = read_preset_selection(&package).expect("preset selection");
    let presets = resolve_presets(&studio, &selection, &scratch.path().join("cache"))
        .expect("resolve presets");
    let report = slice_project(
        &studio,
        &presets,
        &package,
        &scratch.path().join("out"),
        &|| false,
    )
    .expect("slice");
    let parts = part_footprints(&package).expect("part footprints");
    println!(
        "selection: {}",
        serde_json::to_string(&selection).unwrap_or_default()
    );
    for part in &parts {
        println!(
            "part {:?} extruder {} bbox {:?} contact triangles {}",
            part.part_name,
            part.extruder,
            part.bbox,
            part.contact_triangles.len()
        );
    }
    (scratch, report, parts, presets)
}

fn print_checks(report: &SliceReport, checks: &[Check]) {
    for tool in &report.layer1 {
        let mut widths: Vec<String> = tool
            .segments
            .iter()
            .map(|s| format!("{:.3}", s.width_mm))
            .collect();
        widths.sort();
        widths.dedup();
        println!(
            "layer1 T{} {:.1} mm bbox {:?} segments {} widths {}",
            tool.tool,
            tool.extruded_mm,
            tool.bbox,
            tool.segments.len(),
            widths.join("/")
        );
    }
    for check in checks {
        println!(
            "{:<5} {:?}: {}",
            if check.passed { "PASS" } else { "FAIL" },
            check.id,
            check.detail
        );
    }
}

#[test]
#[ignore = "needs BAMBU_STUDIO_CLI and the private M3D_PROVEN_3MF package"]
fn slices_the_proven_package_and_passes_every_check() {
    let (_scratch, report, parts, presets) = slice_proven();
    let checks = verify(&report, &parts, &presets);
    println!(
        "input sha256: {} -> {}",
        report.input_sha256_before, report.input_sha256_after
    );
    print_checks(&report, &checks);
    assert!(checks.iter().all(|c| c.passed), "every check passes");
}

/// Turns every layer-1 extrusion of `tool` that ends inside `interior` into a travel move by
/// dropping its `E` word. Returns the edited G-code and how many moves it emptied.
fn strip_interior_extrusion(gcode: &str, tool: u8, interior: Bbox) -> (String, usize) {
    let (mut layer, mut current, mut x, mut y, mut stripped) = (0, None, 0.0, 0.0, 0);
    let mut out = String::with_capacity(gcode.len());
    for line in gcode.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("; CHANGE_LAYER") {
            layer += 1;
        }
        let code = trimmed.split(';').next().unwrap_or_default();
        let mut words = code.split_whitespace();
        let command = words.next().unwrap_or_default();
        if let Some(t) = command.strip_prefix('T').and_then(|n| n.parse::<u8>().ok()) {
            current = Some(t).filter(|t| *t < u8::MAX).or(current);
        }
        let mut kept = line.to_owned();
        if matches!(command, "G0" | "G1" | "G2" | "G3") {
            let mut has_e = false;
            for word in words {
                match word.split_at(1) {
                    ("X", v) => x = v.parse().unwrap_or(x),
                    ("Y", v) => y = v.parse().unwrap_or(y),
                    ("E", v) => has_e = v.parse::<f64>().is_ok_and(|e| e > 0.0),
                    _ => {}
                }
            }
            let inside = (interior.min_x..=interior.max_x).contains(&x)
                && (interior.min_y..=interior.max_y).contains(&y);
            if layer == 1 && current == Some(tool) && has_e && inside {
                kept = code
                    .split_whitespace()
                    .filter(|w| !w.starts_with('E'))
                    .collect::<Vec<_>>()
                    .join(" ");
                stripped += 1;
            }
        }
        out.push_str(&kept);
        out.push('\n');
    }
    (out, stripped)
}

#[test]
#[ignore = "needs BAMBU_STUDIO_CLI and the private M3D_PROVEN_3MF package"]
fn deleting_one_inks_interior_text_fails_only_layer1_coverage() {
    let (scratch, mut report, parts, presets) = slice_proven();
    // Navy (T1) is lettering; keep its outermost strokes so bbox and extrusion checks
    // still see the right extremes, and delete everything in the middle half.
    let navy = report
        .layer1
        .iter()
        .find(|t| t.tool == 1)
        .expect("T1 prints on layer 1");
    let (w, h) = (
        navy.bbox.max_x - navy.bbox.min_x,
        navy.bbox.max_y - navy.bbox.min_y,
    );
    let interior = Bbox {
        min_x: navy.bbox.min_x + w / 4.0,
        max_x: navy.bbox.max_x - w / 4.0,
        min_y: navy.bbox.min_y + h / 4.0,
        max_y: navy.bbox.max_y - h / 4.0,
    };
    let original = fs::read_to_string(&report.gcode[0].path).expect("plate_1.gcode");
    let (tampered, stripped) = strip_interior_extrusion(&original, 1, interior);
    let tampered_path = scratch.path().join("tampered-plate_1.gcode");
    fs::write(&tampered_path, &tampered).expect("write tampered copy");
    let scan = gcode::scan(BufReader::new(
        fs::File::open(&tampered_path).expect("open tampered copy"),
    ))
    .expect("scan tampered copy");
    println!("stripped {stripped} T1 extrusion moves inside {interior:?}");
    report.layer1 = scan.layer1;

    let checks = verify(&report, &parts, &presets);
    print_checks(&report, &checks);
    let failed: Vec<CheckId> = checks.iter().filter(|c| !c.passed).map(|c| c.id).collect();
    assert!(stripped > 0, "the tamper removed some extrusion");
    assert_eq!(failed, vec![CheckId::Layer1Coverage]);
}
