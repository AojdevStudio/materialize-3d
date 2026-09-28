//! Single-pass scan of a Bambu plate G-code file: content hash, the serialized
//! `machine_start_gcode` header value, and per-tool first-layer extrusion footprints
//! (bbox plus every extrusion segment, so verification can compare actual coverage).

use std::collections::BTreeMap;
use std::f64::consts::{FRAC_PI_2, TAU};
use std::io::{self, BufRead};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{hex, Bbox};

/// Line width assumed when neither a `; LINE_WIDTH:` comment nor the header's
/// `initial_layer_line_width` says otherwise.
pub(crate) const DEFAULT_LINE_WIDTH_MM: f64 = 0.5;
/// Largest distance an arc's chords may stray from the true arc.
const ARC_CHORD_TOLERANCE_MM: f64 = 0.01;
const MAX_ARC_CHORDS: f64 = 1024.0;

/// Where one tool (filament slot, 0-based `T` index) extruded on layer 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolFootprint {
    pub tool: u8,
    /// Filament length pushed on layer 1, in mm of filament.
    pub extruded_mm: f64,
    pub bbox: Bbox,
    /// Every layer-1 extruding XY move, in file order; arcs arrive as short chords.
    pub segments: Vec<ExtrusionSegment>,
}

/// One straight extrusion on the bed, in plate millimetres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ExtrusionSegment {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    /// Extrusion width from the G-code's line-width comment, else the header's
    /// `initial_layer_line_width`, else [`DEFAULT_LINE_WIDTH_MM`].
    pub width_mm: f64,
}

pub(crate) struct GcodeScan {
    pub sha256: String,
    /// Raw value of the `; machine_start_gcode = ...` config line, still escaped.
    pub machine_start_gcode: Option<String>,
    pub layer1: Vec<ToolFootprint>,
}

const START_GCODE_PREFIX: &str = "; machine_start_gcode = ";
const INITIAL_LINE_WIDTH_PREFIX: &str = "; initial_layer_line_width = ";

pub(crate) fn scan(mut reader: impl BufRead) -> io::Result<GcodeScan> {
    let mut hasher = Sha256::new();
    let mut machine_start_gcode = None;
    let mut initial_line_width = None;
    let mut layer1 = Layer1::default();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        if reader.read_until(b'\n', &mut buf)? == 0 {
            break;
        }
        hasher.update(&buf);
        if layer1.finished && machine_start_gcode.is_some() && initial_line_width.is_some() {
            continue;
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches(['\n', '\r']);
        if machine_start_gcode.is_none() {
            if let Some(value) = line.strip_prefix(START_GCODE_PREFIX) {
                machine_start_gcode = Some(value.to_owned());
                continue;
            }
        }
        if initial_line_width.is_none() {
            if let Some(value) = line.strip_prefix(INITIAL_LINE_WIDTH_PREFIX) {
                initial_line_width = value.trim().parse::<f64>().ok().filter(|w| *w > 0.0);
                continue;
            }
        }
        if !layer1.finished {
            layer1.feed(line);
        }
    }
    Ok(GcodeScan {
        sha256: hex(&hasher.finalize()),
        machine_start_gcode,
        layer1: layer1.footprints(initial_line_width.unwrap_or(DEFAULT_LINE_WIDTH_MM)),
    })
}

/// Motion state machine that follows the printer from the start G-code through the end of
/// the first layer. The start G-code picks the first tool (indented `T<n>` lines), so tool
/// state must be tracked before the first `; CHANGE_LAYER`.
#[derive(Default)]
struct Layer1 {
    layers_seen: u32,
    finished: bool,
    tool: Option<u8>,
    x: Option<f64>,
    y: Option<f64>,
    relative_xy: bool,
    relative_e: bool,
    last_e: f64,
    /// Width from the most recent `; LINE_WIDTH:` / `;WIDTH:` comment.
    line_width: Option<f64>,
    tools: BTreeMap<u8, ToolLayer1>,
}

#[derive(Default)]
struct ToolLayer1 {
    extruded_mm: f64,
    bbox: Option<Bbox>,
    /// Width stays `None` until the header default is known at end of file.
    segments: Vec<([f64; 4], Option<f64>)>,
}

impl Layer1 {
    fn feed(&mut self, line: &str) {
        let trimmed = line.trim_start();
        if let Some(width) = ["; LINE_WIDTH:", ";WIDTH:"]
            .iter()
            .find_map(|prefix| trimmed.strip_prefix(prefix))
        {
            self.line_width = width.trim().parse::<f64>().ok().filter(|w| *w > 0.0);
            return;
        }
        if trimmed.starts_with("; CHANGE_LAYER") {
            self.layers_seen += 1;
            self.finished = self.layers_seen > 1;
            return;
        }
        let code = trimmed.split(';').next().unwrap_or_default().trim();
        let mut words = code.split_whitespace();
        let Some(command) = words.next() else { return };
        match command {
            "M82" => self.relative_e = false,
            "M83" => self.relative_e = true,
            "G90" => self.relative_xy = false,
            "G91" => self.relative_xy = true,
            "G92" => {
                for (letter, value) in words.filter_map(parse_word) {
                    match letter {
                        'E' => self.last_e = value,
                        'X' => self.x = Some(value),
                        'Y' => self.y = Some(value),
                        _ => {}
                    }
                }
            }
            "G0" | "G1" | "G2" | "G3" => self.motion(command, words),
            _ => {
                // T255 and above are Bambu sentinels (unload, nozzle ops), not filament slots.
                if let Some(tool) = command.strip_prefix('T').and_then(|n| n.parse::<u8>().ok()) {
                    if tool < u8::MAX {
                        self.tool = Some(tool);
                    }
                }
            }
        }
    }

    fn motion<'a>(&mut self, command: &str, words: impl Iterator<Item = &'a str>) {
        let (mut x, mut y, mut e, mut i, mut j) = (None, None, None, None, None);
        for (letter, value) in words.filter_map(parse_word) {
            match letter {
                'X' => x = Some(value),
                'Y' => y = Some(value),
                'E' => e = Some(value),
                'I' => i = Some(value),
                'J' => j = Some(value),
                _ => {}
            }
        }
        let axis = |target: Option<f64>, current: Option<f64>| match (target, self.relative_xy) {
            (Some(v), false) => Some(v),
            (Some(v), true) => current.map(|c| c + v),
            (None, _) => current,
        };
        let (next_x, next_y) = (axis(x, self.x), axis(y, self.y));

        let extruded = e.map_or(0.0, |e| {
            if self.relative_e {
                e
            } else {
                let delta = e - self.last_e;
                self.last_e = e;
                delta
            }
        });

        if self.layers_seen == 1 && extruded > 0.0 {
            if let Some(tool) = self.tool {
                let entry = self.tools.entry(tool).or_default();
                entry.extruded_mm += extruded;
                let moved_xy = x.is_some() || y.is_some();
                if let (true, Some(sx), Some(sy), Some(ex), Some(ey)) =
                    (moved_xy, self.x, self.y, next_x, next_y)
                {
                    let bbox = entry.bbox.get_or_insert_with(|| Bbox::point(sx, sy));
                    bbox.include(sx, sy);
                    bbox.include(ex, ey);
                    let width = self.line_width;
                    match (i, j, command) {
                        (Some(i), Some(j), "G2" | "G3") => {
                            let arc =
                                Arc::new((sx, sy), (ex, ey), (sx + i, sy + j), command == "G3");
                            arc.include_extremes(bbox);
                            let mut from = (sx, sy);
                            for to in arc.chord_points((ex, ey)) {
                                entry.segments.push(([from.0, from.1, to.0, to.1], width));
                                from = to;
                            }
                        }
                        _ => entry.segments.push(([sx, sy, ex, ey], width)),
                    }
                }
            }
        }
        self.x = next_x;
        self.y = next_y;
    }

    /// `default_width` fills segments printed before any line-width comment.
    fn footprints(self, default_width: f64) -> Vec<ToolFootprint> {
        self.tools
            .into_iter()
            .filter_map(|(tool, acc)| {
                let segments = acc
                    .segments
                    .into_iter()
                    .map(|([x0, y0, x1, y1], width)| ExtrusionSegment {
                        x0,
                        y0,
                        x1,
                        y1,
                        width_mm: width.unwrap_or(default_width),
                    })
                    .collect();
                acc.bbox.map(|bbox| ToolFootprint {
                    tool,
                    extruded_mm: acc.extruded_mm,
                    bbox,
                    segments,
                })
            })
            .collect()
    }
}

fn parse_word(word: &str) -> Option<(char, f64)> {
    let mut chars = word.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    chars.as_str().parse().ok().map(|value| (letter, value))
}

/// A G2/G3 arc: centre, radius, start angle, and sweep in the direction of travel.
struct Arc {
    center: (f64, f64),
    radius: f64,
    a0: f64,
    sweep: f64,
    ccw: bool,
}

impl Arc {
    fn new(start: (f64, f64), end: (f64, f64), center: (f64, f64), ccw: bool) -> Self {
        let radius = (start.0 - center.0).hypot(start.1 - center.1);
        let a0 = (start.1 - center.1).atan2(start.0 - center.0);
        let a1 = (end.1 - center.1).atan2(end.0 - center.0);
        let raw_sweep = if ccw { a1 - a0 } else { a0 - a1 };
        let mut sweep = raw_sweep.rem_euclid(TAU);
        if sweep < 1e-9 {
            sweep = TAU; // start == end: full circle
        }
        Self {
            center,
            radius,
            a0,
            sweep,
            ccw,
        }
    }

    fn point_at(&self, angle: f64) -> (f64, f64) {
        (
            self.center.0 + self.radius * angle.cos(),
            self.center.1 + self.radius * angle.sin(),
        )
    }

    /// Adds the axis-extreme points the arc passes through, which its endpoints alone miss.
    fn include_extremes(&self, bbox: &mut Bbox) {
        for quadrant in 0..4 {
            let theta = f64::from(quadrant) * FRAC_PI_2;
            let offset = if self.ccw {
                theta - self.a0
            } else {
                self.a0 - theta
            }
            .rem_euclid(TAU);
            if offset < self.sweep {
                let (x, y) = self.point_at(theta);
                bbox.include(x, y);
            }
        }
    }

    /// Chord endpoints after the start, ending exactly at `end`, each chord within
    /// [`ARC_CHORD_TOLERANCE_MM`] of the arc.
    fn chord_points(&self, end: (f64, f64)) -> impl Iterator<Item = (f64, f64)> + '_ {
        let step = if self.radius > ARC_CHORD_TOLERANCE_MM {
            2.0 * (1.0 - ARC_CHORD_TOLERANCE_MM / self.radius).acos()
        } else {
            self.sweep
        };
        // Bounded by MAX_ARC_CHORDS, so the cast cannot truncate.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let chords = (self.sweep / step).ceil().clamp(1.0, MAX_ARC_CHORDS) as u32;
        let direction = if self.ccw { 1.0 } else { -1.0 };
        (1..=chords).map(move |k| {
            if k == chords {
                end
            } else {
                let t = f64::from(k) / f64::from(chords);
                self.point_at(self.a0 + direction * t * self.sweep)
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer1(gcode: &str) -> Vec<ToolFootprint> {
        scan(gcode.as_bytes()).expect("scan").layer1
    }

    fn close(a: &Bbox, expected: [f64; 4]) -> bool {
        a.max_edge_deviation(&Bbox {
            min_x: expected[0],
            max_x: expected[1],
            min_y: expected[2],
            max_y: expected[3],
        }) < 1e-9
    }

    // Shape of a real P2S file: indented start-G-code tool pick, a purge with E moves off the
    // part, layer 1 in T2, then `M620 S0A` / `T0` mid-layer, then layer 2.
    const P2S_LIKE: &str = "\
; HEADER_BLOCK_START
; machine_start_gcode = M140 S60\\n  T[initial_no_support_filament_id]\\n
; CONFIG_BLOCK_END
  M620 S2A   ; switch material if AMS exist
  M400
  T2
  M621 S2A
  G90
  M83
  G0 X100 Y0 F24000
  G1 X120 Y0 E5
  G91
  G1 Y-16 F12000 ; move away from the trash bin
  G90
  G1 E-3 F1800
M83 ; use relative distances for extrusion
; CHANGE_LAYER
; Z_HEIGHT: 0.2
G1 X70 Y46 F12000
G1 E.8 F1800
G1 X185 Y46 E4.1
G1 X185 Y212 E6.0
M620 S0A
M400
T0
M621 S0A
G1 X53 Y23 F30000
G1 X203 Y23 E5
G1 X203 Y233 E7
; CHANGE_LAYER
; Z_HEIGHT: 0.4
T1
G1 X0 Y0 E3
";

    #[test]
    fn first_extrusion_uses_the_indented_start_gcode_tool() {
        let tools = layer1(P2S_LIKE);
        let t2 = tools
            .iter()
            .find(|t| t.tool == 2)
            .expect("T2 extrudes on layer 1");
        assert!(close(&t2.bbox, [70.0, 185.0, 46.0, 212.0]), "{:?}", t2.bbox);
        assert!(
            (t2.extruded_mm - 10.9).abs() < 1e-9,
            "includes the pure-E prime: {}",
            t2.extruded_mm
        );
    }

    #[test]
    fn mid_layer_tool_change_moves_extrusion_to_the_new_tool_and_stops_at_layer_two() {
        let tools = layer1(P2S_LIKE);
        assert_eq!(
            tools.iter().map(|t| t.tool).collect::<Vec<_>>(),
            vec![0, 2],
            "T1 only prints on layer 2"
        );
        let t0 = &tools[0];
        assert!(close(&t0.bbox, [53.0, 203.0, 23.0, 233.0]), "{:?}", t0.bbox);
        assert!((t0.extruded_mm - 12.0).abs() < 1e-9);
    }

    #[test]
    fn reads_the_serialized_start_gcode_header() {
        let scan = scan(P2S_LIKE.as_bytes()).expect("scan");
        assert_eq!(
            scan.machine_start_gcode.as_deref(),
            Some("M140 S60\\n  T[initial_no_support_filament_id]\\n")
        );
    }

    #[test]
    fn absolute_extrusion_counts_only_positive_deltas() {
        let tools = layer1("T1\nM82\nG92 E0\n; CHANGE_LAYER\nG1 X0 Y0\nG1 X10 Y0 E2\nG1 X10 Y5 E1.5\nG1 X20 Y5 E4\n");
        assert_eq!(tools.len(), 1);
        assert!((tools[0].extruded_mm - 4.5).abs() < 1e-9);
        assert!(
            close(&tools[0].bbox, [0.0, 20.0, 0.0, 5.0]),
            "retracting move is excluded: {:?}",
            tools[0].bbox
        );
    }

    #[test]
    fn arcs_include_their_axis_extremes() {
        // Counter-clockwise half circle from (10,0) to (-10,0) around the origin crosses (0,10).
        let tools = layer1("T0\nM83\n; CHANGE_LAYER\nG1 X10 Y0\nG3 X-10 Y0 I-10 J0 E3\n");
        assert!(
            close(&tools[0].bbox, [-10.0, 10.0, 0.0, 10.0]),
            "{:?}",
            tools[0].bbox
        );
        let tools = layer1("T0\nM83\n; CHANGE_LAYER\nG1 X10 Y0\nG2 X-10 Y0 I-10 J0 E3\n");
        assert!(
            close(&tools[0].bbox, [-10.0, 10.0, -10.0, 0.0]),
            "{:?}",
            tools[0].bbox
        );
    }

    #[test]
    fn arcs_become_chords_that_hug_the_arc() {
        let tools = layer1("T0\nM83\n; CHANGE_LAYER\nG1 X10 Y0\nG3 X-10 Y0 I-10 J0 E3\n");
        let segments = &tools[0].segments;
        assert!(segments.len() > 16, "{} chords", segments.len());
        let first = segments.first().expect("chords");
        let last = segments.last().expect("chords");
        assert_eq!((first.x0, first.y0), (10.0, 0.0));
        assert_eq!((last.x1, last.y1), (-10.0, 0.0));
        for s in segments {
            let (mx, my) = ((s.x0 + s.x1) / 2.0, (s.y0 + s.y1) / 2.0);
            let sagitta = 10.0 - mx.hypot(my);
            assert!((0.0..=ARC_CHORD_TOLERANCE_MM).contains(&sagitta), "{s:?}");
            assert!(
                my >= -1e-9,
                "counter-clockwise stays in the upper half: {s:?}"
            );
        }
    }

    #[test]
    fn segments_take_the_comment_width_then_the_header_then_the_default() {
        let gcode = "; initial_layer_line_width = 0.45\nT0\nM83\n; CHANGE_LAYER\n\
            G1 X0 Y0\nG1 X10 Y0 E1\n; LINE_WIDTH: 0.42\nG1 X10 Y5 E1\nG1 X12 Y5\nG1 E0.5\n\
            ;WIDTH:0.38\nG1 X12 Y9 E1\n";
        let widths = |gcode: &str| -> Vec<([f64; 4], f64)> {
            layer1(gcode)[0]
                .segments
                .iter()
                .map(|s| ([s.x0, s.y0, s.x1, s.y1], s.width_mm))
                .collect()
        };
        assert_eq!(
            widths(gcode),
            vec![
                ([0.0, 0.0, 10.0, 0.0], 0.45),
                ([10.0, 0.0, 10.0, 5.0], 0.42),
                ([12.0, 5.0, 12.0, 9.0], 0.38),
            ],
            "travel and pure-E moves lay no bead"
        );
        assert_eq!(
            widths("T0\nM83\n; CHANGE_LAYER\nG1 X0 Y0\nG1 X10 Y0 E1\n"),
            vec![([0.0, 0.0, 10.0, 0.0], DEFAULT_LINE_WIDTH_MM)]
        );
    }
}
