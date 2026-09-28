use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::coverage::{self, Grid, Triangle};
use super::gcode::DEFAULT_LINE_WIDTH_MM;
use super::{Bbox, ExtrusionSegment, JsonMap, PartFootprint, ResolvedPresets, SliceReport};

/// Largest allowed distance (mm) between a tool's layer-1 bbox edge and its parts' footprint.
const PLACEMENT_TOLERANCE_MM: f64 = 1.0;

/// Raster resolution for [`CheckId::Layer1Coverage`]: 0.1 mm pixels, a fifth of a line width.
const COVERAGE_PX_PER_MM: f64 = 10.0;
/// Refuse rasters past about a 630 mm square rather than allocate without bound.
const COVERAGE_MAX_PIXELS: usize = 40_000_000;
// Thresholds come from the proven door-sign slice (Bambu Studio 02.08.02.61, P2S): the worst
// tool, navy lettering, measured recall 0.996, and every tool measured spill 0.000. Recall 0.99
// leaves that noise floor a 0.006 margin while failing omissions near 1% of a tool's core
// (deleting one 5 mm box of navy lettering drops recall to as low as 0.975; deleting the middle
// half drops it to 0.476). A swapped, rotated, or stray layer moves far more than 1% of a
// tool's beads off its footprint.
/// Least share of each tool's footprint core its layer-1 extrusion must cover.
const MIN_LAYER1_RECALL: f64 = 0.99;
/// Largest share of each tool's layer-1 extrusion that may land off its footprint.
const MAX_LAYER1_SPILL: f64 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckId {
    SliceSucceeded,
    NoWarnings,
    PresetsApplied,
    StartGcodeIntact,
    InputUnchanged,
    FilamentsPreserved,
    PlacementPreserved,
    Layer1Coverage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    pub id: CheckId,
    pub passed: bool,
    pub detail: String,
}

impl Check {
    fn new(id: CheckId, failures: Vec<String>, ok_detail: impl Into<String>) -> Self {
        let passed = failures.is_empty();
        let detail = if passed {
            ok_detail.into()
        } else {
            failures.join("; ")
        };
        Self { id, passed, detail }
    }
}

/// Judges a slice against what the project asked for. Returns one [`Check`] per [`CheckId`],
/// in declaration order.
pub fn verify(
    report: &SliceReport,
    parts: &[PartFootprint],
    presets: &ResolvedPresets,
) -> Vec<Check> {
    vec![
        slice_succeeded(report),
        no_warnings(report),
        presets_applied(report, presets),
        start_gcode_intact(report),
        input_unchanged(report),
        filaments_preserved(report, parts, presets),
        placement_preserved(report, parts),
        layer1_coverage(report, parts),
    ]
}

fn slice_succeeded(report: &SliceReport) -> Check {
    let mut failures = Vec::new();
    if report.exit_code != Some(0) {
        failures.push(format!("Bambu exited {:?}", report.exit_code));
    }
    if report.return_code != 0 {
        failures.push(format!(
            "return_code {}: {}",
            report.return_code, report.error_string
        ));
    }
    if report.gcode.is_empty() {
        failures.push("no plate G-code produced".into());
    }
    Check::new(
        CheckId::SliceSucceeded,
        failures,
        format!("exit 0, return_code 0, {} plate(s)", report.gcode.len()),
    )
}

fn no_warnings(report: &SliceReport) -> Check {
    let failures = report
        .plate_warnings
        .iter()
        .filter(|w| !w.message.is_empty())
        .map(|w| format!("plate {}: {}", w.plate_id, w.message))
        .collect();
    Check::new(CheckId::NoWarnings, failures, "no plate warnings")
}

fn str_list<'a>(config: &'a JsonMap, key: &str) -> Option<Vec<&'a str>> {
    config
        .get(key)?
        .as_array()?
        .iter()
        .map(Value::as_str)
        .collect()
}

fn presets_applied(report: &SliceReport, presets: &ResolvedPresets) -> Check {
    let Some(effective) = &report.effective else {
        return Check::new(
            CheckId::PresetsApplied,
            vec!["no effective settings exported".into()],
            "",
        );
    };
    let machine = &presets.machine;
    let process = &presets.process;
    let mut failures = Vec::new();
    let mut expect = |key: &str, actual: String, expected: String| {
        if actual != expected {
            failures.push(format!("{key} is {actual}, expected {expected}"));
        }
    };
    expect(
        "printer_settings_id",
        format!("{:?}", effective.printer_settings_id),
        format!("{:?}", machine.name),
    );
    expect(
        "print_settings_id",
        format!("{:?}", effective.print_settings_id),
        format!("{:?}", process.name),
    );
    let filament_names: Vec<&str> = presets.filaments.iter().map(|f| f.name.as_str()).collect();
    expect(
        "filament_settings_id",
        format!("{:?}", effective.filament_settings_id),
        format!("{filament_names:?}"),
    );
    // Catch Bambu's silent fallback to a generic machine or a project-level override.
    expect(
        "nozzle_diameter",
        format!("{:?}", effective.nozzle_diameter),
        format!(
            "{:?}",
            str_list(&machine.config, "nozzle_diameter").unwrap_or_default()
        ),
    );
    expect(
        "printable_area",
        format!("{:?}", effective.printable_area),
        format!(
            "{:?}",
            str_list(&machine.config, "printable_area").unwrap_or_default()
        ),
    );
    expect(
        "layer_height",
        format!("{:?}", effective.layer_height),
        format!(
            "{:?}",
            process
                .config
                .get("layer_height")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
    );
    Check::new(
        CheckId::PresetsApplied,
        failures,
        format!(
            "{} / {} / {} filament(s)",
            machine.name,
            process.name,
            filament_names.len()
        ),
    )
}

fn start_gcode_intact(report: &SliceReport) -> Check {
    let mut failures = Vec::new();
    match &report.effective {
        None => failures.push("no effective settings exported".into()),
        Some(effective) => {
            if !effective.start_gcode_matches_preset {
                failures.push(
                    "effective machine_start_gcode differs from the resolved machine preset".into(),
                );
            }
            if !effective.start_gcode_in_gcode_header {
                failures.push(
                    "G-code header machine_start_gcode differs from the resolved machine preset"
                        .into(),
                );
            }
        }
    }
    Check::new(
        CheckId::StartGcodeIntact,
        failures,
        "preset start G-code in effective settings and G-code header",
    )
}

fn input_unchanged(report: &SliceReport) -> Check {
    let failures = if report.input_sha256_before == report.input_sha256_after {
        Vec::new()
    } else {
        vec![format!(
            "input sha256 changed from {} to {}",
            report.input_sha256_before, report.input_sha256_after
        )]
    };
    Check::new(
        CheckId::InputUnchanged,
        failures,
        format!("sha256 {}", report.input_sha256_after),
    )
}

/// Tool index (`T<n>`) that prints a 1-based filament slot.
fn tool_for(extruder: u8) -> u8 {
    extruder.saturating_sub(1)
}

fn filaments_preserved(
    report: &SliceReport,
    parts: &[PartFootprint],
    presets: &ResolvedPresets,
) -> Check {
    let mut failures = Vec::new();
    let effective_count = report
        .effective
        .as_ref()
        .map(|e| e.filament_settings_id.len());
    if effective_count != Some(presets.filaments.len()) {
        failures.push(format!(
            "effective filament count {effective_count:?}, selection has {}",
            presets.filaments.len()
        ));
    }
    for part in parts {
        let tool = tool_for(part.extruder);
        let extrudes = report
            .layer1
            .iter()
            .any(|t| t.tool == tool && t.extruded_mm > 0.0);
        if !extrudes {
            failures.push(format!(
                "part {:?} (filament {}) has no T{tool} extrusion on layer 1",
                part.part_name, part.extruder
            ));
        }
    }
    let tools: Vec<String> = report
        .layer1
        .iter()
        .map(|t| format!("T{} {:.1} mm", t.tool, t.extruded_mm))
        .collect();
    Check::new(
        CheckId::FilamentsPreserved,
        failures,
        format!("layer 1: {}", tools.join(", ")),
    )
}

fn placement_preserved(report: &SliceReport, parts: &[PartFootprint]) -> Check {
    let mut expected: BTreeMap<u8, Bbox> = BTreeMap::new();
    for part in parts {
        let tool = tool_for(part.extruder);
        let merged = expected
            .get(&tool)
            .map_or(part.bbox, |bbox| bbox.union(&part.bbox));
        expected.insert(tool, merged);
    }
    let mut failures = Vec::new();
    let mut deviations = Vec::new();
    for (tool, footprint) in &expected {
        match report.layer1.iter().find(|t| t.tool == *tool) {
            None => failures.push(format!("T{tool} has no layer-1 extrusion to compare")),
            Some(actual) => {
                let deviation = actual.bbox.max_edge_deviation(footprint);
                deviations.push(format!("T{tool} {deviation:.3} mm"));
                if deviation > PLACEMENT_TOLERANCE_MM {
                    failures.push(format!(
                        "T{tool} layer-1 bbox {:?} is {deviation:.3} mm from footprint {footprint:?}",
                        actual.bbox
                    ));
                }
            }
        }
    }
    if expected.is_empty() {
        failures.push("project has no plate-contact parts to compare".into());
    }
    Check::new(
        CheckId::PlacementPreserved,
        failures,
        format!(
            "max edge deviation within {PLACEMENT_TOLERANCE_MM} mm: {}",
            deviations.join(", ")
        ),
    )
}

/// Length-weighted mean bead width: arachne varies widths per segment (0.30 to 0.75 mm on
/// the proven sign), and the few widest beads should not set the erosion for all of them.
fn typical_width(segments: &[ExtrusionSegment]) -> f64 {
    let (weighted, length) = segments.iter().fold((0.0, 0.0), |(weighted, length), s| {
        let l = (s.x1 - s.x0).hypot(s.y1 - s.y0);
        (weighted + s.width_mm * l, length + l)
    });
    if length > 0.0 {
        weighted / length
    } else {
        DEFAULT_LINE_WIDTH_MM
    }
}

/// Compares, per tool, the area its layer-1 beads cover with the area its parts' contact
/// triangles cover, on one bed raster. See [`coverage::measure`] for recall and spill.
fn layer1_coverage(report: &SliceReport, parts: &[PartFootprint]) -> Check {
    let fail = |detail: String| Check {
        id: CheckId::Layer1Coverage,
        passed: false,
        detail,
    };
    let mut contact: BTreeMap<u8, Vec<Triangle>> = BTreeMap::new();
    for part in parts {
        contact
            .entry(tool_for(part.extruder))
            .or_default()
            .extend_from_slice(&part.contact_triangles);
    }
    let segments: BTreeMap<u8, &[ExtrusionSegment]> = report
        .layer1
        .iter()
        .map(|t| (t.tool, t.segments.as_slice()))
        .collect();

    let mut window: Option<Bbox> = None;
    let mut include = |x: f64, y: f64| {
        window
            .get_or_insert_with(|| Bbox::point(x, y))
            .include(x, y);
    };
    for [x, y] in contact.values().flatten().flatten() {
        include(*x, *y);
    }
    for s in segments.values().copied().flatten() {
        include(s.x0, s.y0);
        include(s.x1, s.y1);
    }
    let Some(window) = window else {
        return fail("no plate-contact triangles or layer-1 extrusion to compare".into());
    };
    let widest = segments
        .values()
        .copied()
        .flatten()
        .map(|s| s.width_mm)
        .fold(DEFAULT_LINE_WIDTH_MM, f64::max);
    let Some(grid) = Grid::covering(
        &window,
        2.0 * widest + 1.0,
        COVERAGE_PX_PER_MM,
        COVERAGE_MAX_PIXELS,
    ) else {
        return fail(format!(
            "layer-1 window {window:?} is too large to rasterize"
        ));
    };

    let figure = |value: Option<f64>| value.map_or_else(|| "n/a".into(), |v| format!("{v:.3}"));
    let mut passed = true;
    let mut tools = Vec::new();
    for tool in contact
        .keys()
        .chain(segments.keys())
        .collect::<BTreeSet<_>>()
    {
        let tool_segments = segments.get(tool).copied().unwrap_or_default();
        let score = coverage::measure(
            &grid,
            contact.get(tool).map_or(&[], Vec::as_slice),
            tool_segments,
            typical_width(tool_segments),
        );
        let recall_ok = score.recall.is_some_and(|r| r >= MIN_LAYER1_RECALL);
        let spill_ok = score.spill.is_some_and(|s| s <= MAX_LAYER1_SPILL);
        passed &= recall_ok && spill_ok;
        let mut line = format!(
            "T{tool} recall {} spill {}",
            figure(score.recall),
            figure(score.spill)
        );
        if !recall_ok {
            line.push_str(&format!(" (recall below {MIN_LAYER1_RECALL})"));
        }
        if !spill_ok {
            line.push_str(&format!(" (spill above {MAX_LAYER1_SPILL})"));
        }
        tools.push(line);
    }
    Check {
        id: CheckId::Layer1Coverage,
        passed,
        detail: format!(
            "recall >= {MIN_LAYER1_RECALL}, spill <= {MAX_LAYER1_SPILL} per tool: {}",
            tools.join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fabrication::bambu::{
        EffectiveSettings, GcodeFile, PlateWarning, ResolvedPreset, ToolFootprint,
    };
    use serde_json::json;
    use std::f64::consts::PI;
    use std::path::PathBuf;

    fn bbox(min_x: f64, max_x: f64, min_y: f64, max_y: f64) -> Bbox {
        Bbox {
            min_x,
            max_x,
            min_y,
            max_y,
        }
    }

    fn preset(name: &str, config: Value) -> ResolvedPreset {
        let Value::Object(config) = config else {
            panic!("object")
        };
        ResolvedPreset {
            name: name.into(),
            path: PathBuf::from(name),
            source_path: PathBuf::from(name),
            config,
        }
    }

    /// Axis-aligned rectangle `[min_x, min_y, max_x, max_y]` in sign coordinates.
    type Rect = [f64; 4];

    const LINE_WIDTH: f64 = 0.5;
    /// Where the synthetic sign sits on the plate, and its centre there.
    const ORIGIN: [f64; 2] = [100.0, 100.0];
    const CENTER: [f64; 2] = [122.5, 125.0];

    /// White frame around a 5 x 6 checkerboard of 5 mm cells, with a white tab in one inner
    /// corner so the layout is not symmetric. Returns (white, navy, teal) rectangles.
    fn sign_layout() -> [Vec<Rect>; 3] {
        let white = vec![
            [0.0, 0.0, 45.0, 5.0],
            [0.0, 45.0, 45.0, 50.0],
            [0.0, 5.0, 5.0, 45.0],
            [40.0, 5.0, 45.0, 45.0],
            [5.0, 5.0, 10.0, 10.0],
        ];
        let (mut navy, mut teal) = (Vec::new(), Vec::new());
        for i in 0..5_u8 {
            for j in 0..6_u8 {
                let (x, y) = (10.0 + 5.0 * f64::from(i), 10.0 + 5.0 * f64::from(j));
                let cell = [x, y, x + 5.0, y + 5.0];
                if (i + j) % 2 == 0 {
                    navy.push(cell);
                } else {
                    teal.push(cell);
                }
            }
        }
        [white, navy, teal]
    }

    fn on_plate(x: f64, y: f64) -> [f64; 2] {
        [ORIGIN[0] + x, ORIGIN[1] + y]
    }

    fn part(name: &str, extruder: u8, rects: &[Rect]) -> PartFootprint {
        let mut contact_triangles = Vec::new();
        let mut bounds: Option<Bbox> = None;
        for &[x0, y0, x1, y1] in rects {
            let [a, b, c, d] = [
                on_plate(x0, y0),
                on_plate(x1, y0),
                on_plate(x1, y1),
                on_plate(x0, y1),
            ];
            contact_triangles.extend([[a, b, c], [a, c, d]]);
            for [x, y] in [a, c] {
                bounds
                    .get_or_insert_with(|| Bbox::point(x, y))
                    .include(x, y);
            }
        }
        PartFootprint {
            part_name: name.into(),
            extruder,
            bbox: bounds.expect("rects"),
            contact_triangles,
        }
    }

    /// Solid first-layer fill of each rectangle: a perimeter loop half a line inside the
    /// edge, then evenly spaced rows no farther apart than 0.45 mm.
    fn fill(rects: &[Rect]) -> Vec<ExtrusionSegment> {
        let segment = |[x0, y0]: [f64; 2], [x1, y1]: [f64; 2]| ExtrusionSegment {
            x0,
            y0,
            x1,
            y1,
            width_mm: LINE_WIDTH,
        };
        let mut out = Vec::new();
        for &[x0, y0, x1, y1] in rects {
            let h = LINE_WIDTH / 2.0;
            let loop_ = [
                on_plate(x0 + h, y0 + h),
                on_plate(x1 - h, y0 + h),
                on_plate(x1 - h, y1 - h),
                on_plate(x0 + h, y1 - h),
            ];
            for k in 0..4 {
                out.push(segment(loop_[k], loop_[(k + 1) % 4]));
            }
            let (low, high) = (y0 + LINE_WIDTH, y1 - LINE_WIDTH);
            let rows = ((high - low) / 0.45).ceil();
            for row in 0..=rows as u32 {
                let y = low + (high - low) * f64::from(row) / rows;
                out.push(segment(
                    on_plate(x0 + LINE_WIDTH, y),
                    on_plate(x1 - LINE_WIDTH, y),
                ));
            }
        }
        out
    }

    fn tool(tool: u8, segments: Vec<ExtrusionSegment>) -> ToolFootprint {
        let mut bounds: Option<Bbox> = None;
        let mut extruded_mm = 0.0;
        for s in &segments {
            for (x, y) in [(s.x0, s.y0), (s.x1, s.y1)] {
                bounds
                    .get_or_insert_with(|| Bbox::point(x, y))
                    .include(x, y);
            }
            extruded_mm += 0.03 * (s.x1 - s.x0).hypot(s.y1 - s.y0);
        }
        ToolFootprint {
            tool,
            extruded_mm,
            bbox: bounds.expect("segments"),
            segments,
        }
    }

    fn coverage_check(checks: &[Check]) -> &Check {
        checks
            .iter()
            .find(|c| c.id == CheckId::Layer1Coverage)
            .expect("Layer1Coverage runs")
    }

    /// A synthetic three-colour sign shaped like the proven door-sign slice, reduced to what
    /// verify reads: every part's contact area is filled by its own tool on layer 1.
    fn passing() -> (SliceReport, Vec<PartFootprint>, ResolvedPresets) {
        let [white, navy, teal] = sign_layout();
        let filament = "Bambu PLA Basic @BBL P2S";
        let presets = ResolvedPresets {
            app_version: "02.08.02.61".into(),
            cache_dir: PathBuf::new(),
            filaments: vec![
                preset(filament, json!({})),
                preset(filament, json!({})),
                preset(filament, json!({})),
            ],
            machine: preset(
                "Bambu Lab P2S 0.4 nozzle",
                json!({ "nozzle_diameter": ["0.4"], "printable_area": ["0x0", "256x0", "256x256", "0x256"] }),
            ),
            process: preset("0.20mm Standard @BBL P2S", json!({ "layer_height": "0.2" })),
            profile_manifest: PathBuf::new(),
            profile_version: "02.08.00.05".into(),
            resolver_schema_version: 2,
        };
        let report = SliceReport {
            out_dir: PathBuf::new(),
            exit_code: Some(0),
            return_code: 0,
            error_string: "Success.".into(),
            plate_warnings: vec![PlateWarning {
                plate_id: 1,
                message: String::new(),
            }],
            effective: Some(EffectiveSettings {
                printer_settings_id: "Bambu Lab P2S 0.4 nozzle".into(),
                print_settings_id: "0.20mm Standard @BBL P2S".into(),
                filament_settings_id: vec![filament.into(); 3],
                filament_colour: vec!["#FFFFFF".into(), "#123B6D".into(), "#149B98".into()],
                nozzle_diameter: vec!["0.4".into()],
                printable_area: vec![
                    "0x0".into(),
                    "256x0".into(),
                    "256x256".into(),
                    "0x256".into(),
                ],
                layer_height: "0.2".into(),
                enable_prime_tower: false,
                start_gcode_matches_preset: true,
                start_gcode_in_gcode_header: true,
            }),
            gcode: vec![GcodeFile {
                path: PathBuf::from("plate_1.gcode"),
                sha256: "ab".into(),
            }],
            input_sha256_before: "b01c".into(),
            input_sha256_after: "b01c".into(),
            layer1: vec![
                tool(0, fill(&white)),
                tool(1, fill(&navy)),
                tool(2, fill(&teal)),
            ],
            stdout_log: PathBuf::new(),
            stderr_log: PathBuf::new(),
        };
        let parts = vec![
            part("white", 1, &white),
            part("navy", 2, &navy),
            part("teal", 3, &teal),
        ];
        (report, parts, presets)
    }

    fn failed(checks: &[Check]) -> Vec<CheckId> {
        checks.iter().filter(|c| !c.passed).map(|c| c.id).collect()
    }

    #[test]
    fn the_proven_slice_passes_every_check() {
        let (report, parts, presets) = passing();
        let checks = verify(&report, &parts, &presets);
        assert_eq!(checks.len(), 8);
        assert_eq!(failed(&checks), vec![], "{checks:#?}");
    }

    #[test]
    fn full_layer1_coverage_passes_with_per_tool_figures() {
        let (report, parts, presets) = passing();
        let check = coverage_check(&verify(&report, &parts, &presets)).clone();
        assert!(check.passed, "{}", check.detail);
        assert!(
            check.detail.ends_with(
                "T0 recall 1.000 spill 0.000, T1 recall 1.000 spill 0.000, T2 recall 1.000 spill 0.000"
            ),
            "{}",
            check.detail
        );
    }

    #[test]
    fn a_missing_interior_glyph_fails_layer1_coverage() {
        // The blocker: navy keeps its outermost strokes, so its bbox and extrusion total
        // still look right, but every interior navy cell is gone.
        let (mut report, parts, presets) = passing();
        let interior = |s: &ExtrusionSegment| {
            let (x, y) = ((s.x0 + s.x1) / 2.0, (s.y0 + s.y1) / 2.0);
            (115.0..130.0).contains(&x) && (115.0..135.0).contains(&y)
        };
        let navy = &mut report.layer1[1];
        let bbox_before = navy.bbox;
        navy.segments.retain(|s| !interior(s));
        assert_eq!(tool(1, navy.segments.clone()).bbox, bbox_before);

        let checks = verify(&report, &parts, &presets);
        assert_eq!(failed(&checks), vec![CheckId::Layer1Coverage]);
        assert!(
            coverage_check(&checks).detail.contains(&format!(
                "T1 recall 0.600 spill 0.000 (recall below {MIN_LAYER1_RECALL})"
            )),
            "{}",
            coverage_check(&checks).detail
        );
    }

    #[test]
    fn a_swapped_tool_assignment_fails_layer1_coverage() {
        // Navy and teal share a bbox, so only coverage sees each ink on the other's cells.
        let (mut report, parts, presets) = passing();
        report.layer1[1].tool = 2;
        report.layer1[2].tool = 1;
        assert_eq!(
            failed(&verify(&report, &parts, &presets)),
            vec![CheckId::Layer1Coverage]
        );
    }

    #[test]
    fn a_layer_rotated_inside_its_bbox_fails_layer1_coverage() {
        // Rotating the whole layer 180 degrees about the sign centre keeps every tool's bbox
        // in place, so placement passes; coverage sees the cells land on the wrong ink.
        let (mut report, parts, presets) = passing();
        let (sin, cos) = PI.sin_cos();
        let turn = |x: f64, y: f64| {
            let (dx, dy) = (x - CENTER[0], y - CENTER[1]);
            (
                CENTER[0] + dx * cos - dy * sin,
                CENTER[1] + dx * sin + dy * cos,
            )
        };
        for footprint in &mut report.layer1 {
            let turned = footprint
                .segments
                .iter()
                .map(|s| {
                    let ((x0, y0), (x1, y1)) = (turn(s.x0, s.y0), turn(s.x1, s.y1));
                    ExtrusionSegment {
                        x0,
                        y0,
                        x1,
                        y1,
                        ..*s
                    }
                })
                .collect();
            *footprint = tool(footprint.tool, turned);
        }
        assert_eq!(
            failed(&verify(&report, &parts, &presets)),
            vec![CheckId::Layer1Coverage]
        );
    }

    #[test]
    fn a_plate_warning_fails_no_warnings() {
        let (mut report, parts, presets) = passing();
        report.plate_warnings[0].message = "Floating regions detected".into();
        let checks = verify(&report, &parts, &presets);
        assert_eq!(failed(&checks), vec![CheckId::NoWarnings]);
        assert!(checks[1].detail.contains("Floating regions detected"));
    }

    #[test]
    fn a_rotated_layer_fails_placement() {
        // The --arrange 1 regression: the sign came out rotated 90 degrees.
        let (mut report, parts, presets) = passing();
        report.layer1[0].bbox = bbox(23.4, 232.6, 53.4, 202.6);
        assert_eq!(
            failed(&verify(&report, &parts, &presets)),
            vec![CheckId::PlacementPreserved]
        );
    }

    #[test]
    fn a_missing_tool_fails_filaments_and_placement() {
        let (mut report, parts, presets) = passing();
        report.layer1.retain(|t| t.tool != 2);
        let checks = verify(&report, &parts, &presets);
        assert_eq!(
            failed(&checks),
            vec![
                CheckId::FilamentsPreserved,
                CheckId::PlacementPreserved,
                CheckId::Layer1Coverage
            ]
        );
        assert!(
            checks[5]
                .detail
                .contains(r#"part "teal" (filament 3) has no T2 extrusion"#),
            "{}",
            checks[5].detail
        );
    }

    #[test]
    fn a_silent_machine_fallback_fails_presets_applied() {
        let (mut report, parts, presets) = passing();
        if let Some(effective) = &mut report.effective {
            effective.printable_area = vec![
                "0x0".into(),
                "200x0".into(),
                "200x200".into(),
                "0x200".into(),
            ];
        }
        assert_eq!(
            failed(&verify(&report, &parts, &presets)),
            vec![CheckId::PresetsApplied]
        );
    }

    #[test]
    fn checks_serialize_with_snake_case_ids() {
        let check = Check {
            id: CheckId::PlacementPreserved,
            passed: true,
            detail: "ok".into(),
        };
        assert_eq!(
            serde_json::to_value(&check).expect("serialize"),
            json!({ "id": "placement_preserved", "passed": true, "detail": "ok" })
        );
    }
}
