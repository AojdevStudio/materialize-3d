//! Geometry checks that must pass before a sign is packaged.

use std::collections::HashMap;

use serde::Serialize;

use super::geometry::{mm, Body, SignGeometry, UM_PER_MM};

/// Bounds tolerance, µm (0.01 mm).
const BOUNDS_TOLERANCE_UM: i32 = 10;
/// Allowed relative gap between the outline area and base + ink bottom areas.
const AREA_TOLERANCE: f64 = 0.001;
/// Minimum per-region IoU between the finished-face layout and the bed faces.
const MIN_ORIENTATION_IOU: f64 = 0.98;
/// Oracle raster resolution.
const ORACLE_PX_PER_MM: f64 = 4.0;

/// One named check on one subject (a body name, or "sign").
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GeometryCheck {
    pub name: &'static str,
    pub subject: String,
    pub passed: bool,
    pub detail: String,
}

impl GeometryCheck {
    fn new(name: &'static str, subject: &str, passed: bool, detail: String) -> Self {
        Self {
            name,
            subject: subject.to_owned(),
            passed,
            detail,
        }
    }
}

/// Runs every check. A sign is packageable only when all of them pass.
pub fn check_geometry(geometry: &SignGeometry) -> Vec<GeometryCheck> {
    let mut checks = Vec::new();
    for body in &geometry.bodies {
        checks.push(closed_manifold(body));
        checks.push(non_degenerate(body));
        checks.push(outward_orientation(body));
    }
    checks.push(bounds(geometry));
    for body in &geometry.bodies[1..] {
        checks.push(inlay_z_range(body, geometry.dims.d));
    }
    checks.push(area_partition(geometry));
    for body in &geometry.bodies[1..] {
        let area = bottom_area_mm2(body);
        checks.push(GeometryCheck::new(
            "ink_present",
            &body.name,
            area > 0.0,
            format!("finished-face area {area:.3} mm²"),
        ));
    }
    checks.extend(orientation_oracle(geometry));
    checks
}

fn closed_manifold(body: &Body) -> GeometryCheck {
    let mut directed: HashMap<(u32, u32), u32> = HashMap::with_capacity(body.triangles.len() * 3);
    for t in &body.triangles {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *directed.entry((a, b)).or_default() += 1;
        }
    }
    let bad = directed
        .iter()
        .filter(|(&(a, b), &n)| n != 1 || directed.get(&(b, a)) != Some(&1))
        .count();
    GeometryCheck::new(
        "closed_manifold",
        &body.name,
        !body.triangles.is_empty() && bad == 0,
        format!(
            "{} triangles, {} directed edges, {bad} without exactly one opposite twin",
            body.triangles.len(),
            directed.len()
        ),
    )
}

fn corners(body: &Body, t: [u32; 3]) -> [[i64; 3]; 3] {
    t.map(|i| body.vertices[i as usize].map(i64::from))
}

fn sub3(a: [i64; 3], b: [i64; 3]) -> [i64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross3(a: [i64; 3], b: [i64; 3]) -> [i64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn non_degenerate(body: &Body) -> GeometryCheck {
    let degenerate = body
        .triangles
        .iter()
        .filter(|t| {
            let [a, b, c] = corners(body, **t);
            cross3(sub3(b, a), sub3(c, a)) == [0, 0, 0]
        })
        .count();
    GeometryCheck::new(
        "non_degenerate",
        &body.name,
        degenerate == 0,
        format!("{degenerate} zero-area triangles"),
    )
}

fn outward_orientation(body: &Body) -> GeometryCheck {
    let six_volume: i128 = body
        .triangles
        .iter()
        .map(|t| {
            let [a, b, c] = corners(body, *t);
            let n = cross3(b, c);
            (0..3)
                .map(|k| i128::from(a[k]) * i128::from(n[k]))
                .sum::<i128>()
        })
        .sum();
    let volume_mm3 = six_volume as f64 / 6.0 / UM_PER_MM.powi(3);
    GeometryCheck::new(
        "outward_orientation",
        &body.name,
        six_volume > 0,
        format!("signed volume {volume_mm3:.3} mm³"),
    )
}

fn bounds(geometry: &SignGeometry) -> GeometryCheck {
    let mut lo = [i32::MAX; 3];
    let mut hi = [i32::MIN; 3];
    for v in geometry.bodies.iter().flat_map(|b| &b.vertices) {
        for k in 0..3 {
            lo[k] = lo[k].min(v[k]);
            hi[k] = hi[k].max(v[k]);
        }
    }
    let d = geometry.dims;
    let want = [d.w, d.h, d.t];
    let passed = (0..3).all(|k| {
        lo[k].abs() <= BOUNDS_TOLERANCE_UM && (hi[k] - want[k]).abs() <= BOUNDS_TOLERANCE_UM
    });
    GeometryCheck::new(
        "bounds",
        "sign",
        passed,
        format!(
            "min {:?} max {:?} mm, expected 0 to {:?} mm",
            lo.map(mm),
            hi.map(mm),
            want.map(mm)
        ),
    )
}

fn inlay_z_range(body: &Body, depth: i32) -> GeometryCheck {
    let lo = body.vertices.iter().map(|v| v[2]).min();
    let hi = body.vertices.iter().map(|v| v[2]).max();
    GeometryCheck::new(
        "inlay_z_range",
        &body.name,
        lo == Some(0) && hi == Some(depth),
        format!(
            "z {:?} to {:?} mm, expected 0 to {}",
            lo.map(mm),
            hi.map(mm),
            mm(depth)
        ),
    )
}

/// Triangles lying in z = 0: the faces printed against the bed.
fn bed_triangles(body: &Body) -> impl Iterator<Item = [[i64; 3]; 3]> + '_ {
    body.triangles
        .iter()
        .map(|t| corners(body, *t))
        .filter(|c| c.iter().all(|v| v[2] == 0))
}

fn bottom_area_mm2(body: &Body) -> f64 {
    let twice: i64 = bed_triangles(body)
        .map(|[a, b, c]| cross3(sub3(b, a), sub3(c, a))[2].abs())
        .sum();
    twice as f64 / 2.0 / UM_PER_MM.powi(2)
}

fn area_partition(geometry: &SignGeometry) -> GeometryCheck {
    let parts: Vec<f64> = geometry.bodies.iter().map(bottom_area_mm2).collect();
    let total: f64 = parts.iter().sum();
    let outline = geometry.outline_area_mm2;
    let gap = (total - outline).abs() / outline;
    GeometryCheck::new(
        "area_partition",
        "sign",
        gap <= AREA_TOLERANCE,
        format!(
            "bed faces {parts:.2?} sum {total:.3} mm², outline {outline:.3} mm², gap {:.4}%",
            gap * 100.0
        ),
    )
}

/// Compares, per palette entry, the finished-face layout (y down, as read)
/// with the bed faces of the emitted meshes as seen by a camera under the bed.
/// The camera undoes the mirror by where it stands; it never calls the
/// face-down transform.
fn orientation_oracle(geometry: &SignGeometry) -> Vec<GeometryCheck> {
    let s = ORACLE_PX_PER_MM / UM_PER_MM;
    let width = (mm(geometry.dims.w) * ORACLE_PX_PER_MM).ceil() as usize;
    let height = (mm(geometry.dims.h) * ORACLE_PX_PER_MM).ceil() as usize;

    // Camera under the bed looking up: forward = +Z, screen up = +Y, so
    // screen right = forward x up = (0,0,1) x (0,1,0) = (-1,0,0) and screen
    // down = -Y. The image origin is the footprint corner at (max X, max Y).
    let right = [-1.0, 0.0];
    let down = [0.0, -1.0];
    let origin = [f64::from(geometry.dims.w), f64::from(geometry.dims.h)];
    let view = |v: [i64; 3]| {
        let rel = [v[0] as f64 - origin[0], v[1] as f64 - origin[1]];
        [
            (rel[0] * right[0] + rel[1] * right[1]) * s,
            (rel[0] * down[0] + rel[1] * down[1]) * s,
        ]
    };

    geometry
        .bodies
        .iter()
        .zip(&geometry.face)
        .map(|(body, face)| {
            let mut expected = Mask::new(width, height);
            let rings: Vec<Vec<[f64; 2]>> = face
                .iter()
                .flatten()
                .map(|r| {
                    r.iter()
                        .map(|p| [f64::from(p.x) * s, f64::from(p.y) * s])
                        .collect()
                })
                .collect();
            expected.fill_even_odd(&rings);

            let mut seen = Mask::new(width, height);
            for [a, b, c] in bed_triangles(body) {
                seen.fill_even_odd(&[vec![view(a), view(b), view(c)]]);
            }
            let iou = expected.iou(&seen);
            GeometryCheck::new(
                "orientation_oracle",
                &body.name,
                iou >= MIN_ORIENTATION_IOU,
                format!("IoU {iou:.4} (finished face vs bed faces viewed from below)"),
            )
        })
        .collect()
}

/// Binary raster sampled at pixel centers.
struct Mask {
    width: usize,
    height: usize,
    bits: Vec<bool>,
}

impl Mask {
    fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            bits: vec![false; width * height],
        }
    }

    /// Sets (ORs) every pixel whose center is inside `rings` under even-odd.
    fn fill_even_odd(&mut self, rings: &[Vec<[f64; 2]>]) {
        let (mut y_min, mut y_max) = (f64::MAX, f64::MIN);
        for p in rings.iter().flatten() {
            y_min = y_min.min(p[1]);
            y_max = y_max.max(p[1]);
        }
        if y_min > y_max {
            return;
        }
        let row0 = (y_min - 0.5).ceil().max(0.0) as isize;
        let row1 = ((y_max - 0.5).floor() as isize).min(self.height as isize - 1);
        if row1 < row0 {
            return;
        }
        let mut xs = Vec::new();
        for row in row0 as usize..=row1 as usize {
            let yc = row as f64 + 0.5;
            xs.clear();
            for ring in rings {
                let n = ring.len();
                for i in 0..n {
                    let (a, b) = (ring[i], ring[(i + 1) % n]);
                    if (a[1] <= yc) != (b[1] <= yc) {
                        xs.push(a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
                    }
                }
            }
            xs.sort_by(f64::total_cmp);
            for [x0, x1] in xs.as_chunks::<2>().0 {
                let start = (x0 - 0.5).ceil().max(0.0) as usize;
                let end = ((x1 - 0.5).ceil().max(0.0) as usize).min(self.width);
                for col in start..end {
                    self.bits[row * self.width + col] = true;
                }
            }
        }
    }

    fn iou(&self, other: &Mask) -> f64 {
        let (mut both, mut either) = (0usize, 0usize);
        for (a, b) in self.bits.iter().zip(&other.bits) {
            both += usize::from(*a && *b);
            either += usize::from(*a || *b);
        }
        if either == 0 {
            0.0
        } else {
            both as f64 / either as f64
        }
    }
}
