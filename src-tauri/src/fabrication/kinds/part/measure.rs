//! Every check of a part, measured in Rust on the welded mesh the package
//! carries and the slicer slices. Nothing here reads what the script said.

use std::collections::HashMap;

use super::spec::{Axis, Measure, MeasuredRequirement, ValidPart};
use super::{MESH_CHECKS, PRINT_CHECKS};
use crate::fabrication::checks::{CheckId, CheckOutcome, CheckPhase};
use crate::fabrication::layers::slice::{self, ModelLayers, MIN_WALL_MM};
use crate::fabrication::model::{Body, PrintableModel};
use crate::fabrication::printer::Um;

/// How far a part may sit below the bed, or above it, and still rest on it, µm.
const BED_TOLERANCE_UM: Um = 10;
/// The largest unsupported area of one layer that is not an overhang, mm².
/// Below it are the few pixels a curved or chamfered edge leaves.
const OVERHANG_MM2: f64 = 2.0;
/// The largest thin area of one layer that is not a thin wall, mm².
const THIN_MM2: f64 = 1.0;
/// A body that rests on the bed must touch it over at least this much, mm²,
/// and over at least [`MIN_CONTACT_SHARE`] of its largest layer.
const MIN_CONTACT_MM2: f64 = 25.0;
const MIN_CONTACT_SHARE: f64 = 0.1;

/// Every geometry and print check of `model`, in the bound plan's order:
/// each body's mesh checks, every requirement, each body's print checks.
pub fn measure(valid: &ValidPart, model: &PrintableModel) -> Vec<CheckOutcome> {
    let mut outcomes: Vec<CheckOutcome> = model.bodies().iter().flat_map(|body| mesh_checks(body, model, valid.bed())).collect();
    outcomes.extend(valid.requirements().iter().map(|r| requirement(r, model)));
    let layers = slice::slice(model);
    for (index, body) in model.bodies().iter().enumerate() {
        outcomes.extend(print_checks(&layers, index, body));
    }
    outcomes
}

fn outcome(phase: CheckPhase, name: &str, body: &Body, passed: bool, detail: String) -> CheckOutcome {
    CheckOutcome { id: CheckId::new(phase, &format!("{name}.{}", body.name)), passed, detail }
}

fn mesh_checks(body: &Body, model: &PrintableModel, bed: [Um; 3]) -> [CheckOutcome; 4] {
    let [closed, degenerate, outward, bounds] = MESH_CHECKS;
    let geometry = |name: &str, passed: bool, detail: String| outcome(CheckPhase::Geometry, name, body, passed, detail);
    let triangles = body.mesh.triangles();
    let corners = |t: &[u32; 3]| t.map(|i| body.mesh.vertices()[i as usize]);

    let mut directed: HashMap<(u32, u32), u32> = HashMap::with_capacity(triangles.len() * 3);
    for t in triangles {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            *directed.entry((a, b)).or_default() += 1;
        }
    }
    let unmatched = directed.iter().filter(|(&(a, b), &n)| n != 1 || directed.get(&(b, a)) != Some(&1)).count();
    let zero_area = triangles.iter().filter(|t| cross(corners(t)) == [0, 0, 0]).count();
    let six_volume: i128 = triangles
        .iter()
        .map(|t| {
            let [a, b, c] = corners(t);
            let n = [
                i128::from(b[1]) * i128::from(c[2]) - i128::from(b[2]) * i128::from(c[1]),
                i128::from(b[2]) * i128::from(c[0]) - i128::from(b[0]) * i128::from(c[2]),
                i128::from(b[0]) * i128::from(c[1]) - i128::from(b[1]) * i128::from(c[0]),
            ];
            (0..3).map(|k| i128::from(a[k]) * n[k]).sum::<i128>()
        })
        .sum();
    let volume_mm3 = six_volume as f64 / 6.0 / 1e9;

    let (lo, hi) = body_bounds(body);
    let [model_lo, _] = model.bounds();
    let fits = (0..3).all(|k| hi[k] - lo[k] <= bed[k]) && hi[2] <= bed[2];
    let above = lo[2] >= -BED_TOLERANCE_UM;
    let rests = model_lo[2].abs() <= BED_TOLERANCE_UM;
    let range = |k: usize| format!("{:.3} to {:.3}", mm(lo[k]), mm(hi[k]));
    let mut problems = Vec::new();
    if !fits {
        problems.push(format!("does not fit the {} x {} x {} mm build volume", mm(bed[0]), mm(bed[1]), mm(bed[2])));
    }
    if !above {
        problems.push("goes below the bed (z < 0)".to_owned());
    }
    if !rests {
        problems.push(format!("the part's lowest point is at z {:.3} mm, not on the bed (z = 0)", mm(model_lo[2])));
    }
    let bounds_detail = format!("x {} y {} z {} mm{}", range(0), range(1), range(2), if problems.is_empty() { String::new() } else { format!("; {}", problems.join("; ")) });

    [
        geometry(
            closed,
            !triangles.is_empty() && unmatched == 0,
            format!("{} triangles, {} directed edges, {unmatched} without exactly one opposite twin", triangles.len(), directed.len()),
        ),
        geometry(degenerate, zero_area == 0, format!("{zero_area} zero-area triangles")),
        geometry(outward, six_volume > 0, format!("signed volume {volume_mm3:.3} mm³")),
        geometry(bounds, problems.is_empty(), bounds_detail),
    ]
}

fn cross([a, b, c]: [[Um; 3]; 3]) -> [i128; 3] {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]].map(i128::from);
    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]].map(i128::from);
    [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
}

fn body_bounds(body: &Body) -> ([Um; 3], [Um; 3]) {
    let mut lo = [Um::MAX; 3];
    let mut hi = [Um::MIN; 3];
    for v in body.mesh.vertices() {
        for k in 0..3 {
            lo[k] = lo[k].min(v[k]);
            hi[k] = hi[k].max(v[k]);
        }
    }
    (lo, hi)
}

fn mm(um: Um) -> f64 {
    um as f64 / 1000.0
}

fn print_checks(layers: &ModelLayers<'_>, index: usize, body: &Body) -> [CheckOutcome; 3] {
    let [overhang_name, wall_name, contact_name] = PRINT_CHECKS;
    let print = |name: &str, passed: bool, detail: String| outcome(CheckPhase::Print, name, body, passed, detail);

    let overhang = slice::overhang(layers, index);
    let overhang = if overhang.area_mm2 <= OVERHANG_MM2 {
        print(overhang_name, true, format!("every layer rests on the one below it (largest unsupported area {:.1} mm²)", overhang.area_mm2))
    } else {
        print(
            overhang_name,
            false,
            format!(
                "about {:.0} mm² unsupported at z {:.1} mm ({:.0} mm² over all layers); print with supports or turn the part so it rests on a flat face",
                overhang.area_mm2, overhang.z_mm, overhang.total_mm2
            ),
        )
    };

    let thin = slice::thin_walls(layers, index);
    let thin = if thin.area_mm2 <= THIN_MM2 {
        print(wall_name, true, format!("no wall narrower than {MIN_WALL_MM} mm (largest thin area {:.1} mm²)", thin.area_mm2))
    } else {
        print(
            wall_name,
            false,
            format!("about {:.1} mm² narrower than {MIN_WALL_MM} mm at z {:.1} mm; the nozzle may skip it", thin.area_mm2, thin.z_mm),
        )
    };

    let contact = slice::contact(layers, index);
    let contact = match contact.starts_mm {
        Some(start) if start > 0.0 => print(contact_name, true, format!("starts at z {start:.1} mm, on another body; the overhang check covers its support")),
        None => print(contact_name, false, "no layer of this body has material".to_owned()),
        Some(_) => {
            let enough = contact.bed_mm2 >= MIN_CONTACT_MM2 && contact.bed_mm2 >= MIN_CONTACT_SHARE * contact.largest_mm2;
            let detail = format!("touches the bed over {:.0} mm² (largest layer {:.0} mm²)", contact.bed_mm2, contact.largest_mm2);
            if enough {
                print(contact_name, true, detail)
            } else {
                print(contact_name, false, format!("{detail}; it may tip or come loose, so add a brim or turn the part onto a larger face"))
            }
        }
    };
    [overhang, thin, contact]
}

// ─── Requirements ─────────────────────────────────────────────────────────────

/// Measures one declared requirement on the whole model.
fn requirement(requirement: &MeasuredRequirement, model: &PrintableModel) -> CheckOutcome {
    let id = requirement.check_id();
    let name = &requirement.name;
    let judged = |measured: f64, want: Um, tol: Um| {
        let passed = (measured - mm(want)).abs() <= mm(tol) + 1e-9;
        CheckOutcome { id: id.clone(), passed, detail: format!("{name} {measured:.2} mm ({} ± {})", mm(want), mm(tol)) }
    };
    let failed = |why: String| CheckOutcome { id: id.clone(), passed: false, detail: format!("{name}: {why}") };
    let triangles = Triangles::of(model);
    match requirement.measure {
        Measure::Span { axis, um, tol_um } => {
            let [lo, hi] = model.bounds();
            judged(mm(hi[axis.index()] - lo[axis.index()]), um, tol_um)
        }
        Measure::Opening { axis, at_um, um, tol_um } => {
            let at = point(at_um);
            if triangles.inside(at) {
                return failed(format!("the point {} is inside material, not in the gap", show(at_um)));
            }
            let (Some(up), Some(down)) = (triangles.nearest(at, unit(axis, 1.0)), triangles.nearest(at, unit(axis, -1.0))) else {
                return failed(format!("no material closes the gap along {} through {}", axis_name(axis), show(at_um)));
            };
            judged(up + down, um, tol_um)
        }
        Measure::Hole { axis, at_um, um, tol_um } => {
            let at = point(at_um);
            if triangles.inside(at) {
                return failed(format!("the point {} is inside material, not in the hole", show(at_um)));
            }
            match hole_diameter(&triangles, at, axis) {
                Ok(diameter) => judged(diameter, um, tol_um),
                Err(why) => failed(why),
            }
        }
        Measure::MinWall { at_um, um } => {
            let at = point(at_um);
            if !triangles.inside(at) {
                return failed(format!("the point {} is not inside material", show(at_um)));
            }
            let Some(thickness) = wall_thickness(&triangles, at) else {
                return failed(format!("the wall through {} does not close", show(at_um)));
            };
            let passed = thickness + 1e-9 >= mm(um);
            CheckOutcome { id, passed, detail: format!("{name} {thickness:.2} mm (at least {})", mm(um)) }
        }
    }
}

fn axis_name(axis: Axis) -> &'static str {
    match axis {
        Axis::X => "x",
        Axis::Y => "y",
        Axis::Z => "z",
    }
}

fn show(at: [Um; 3]) -> String {
    format!("[{}, {}, {}]", mm(at[0]), mm(at[1]), mm(at[2]))
}

/// A probe point, nudged off the axes' planes by a few nanometers so a ray
/// through it never runs exactly along a triangle's edge or through a vertex.
fn point(at: [Um; 3]) -> [f64; 3] {
    [mm(at[0]) + 1.37e-6, mm(at[1]) + 2.11e-6, mm(at[2]) + 3.07e-6]
}

fn unit(axis: Axis, sign: f64) -> [f64; 3] {
    let mut d = [0.0; 3];
    d[axis.index()] = sign;
    d
}

/// Every triangle of every body, in millimeters.
struct Triangles(Vec<[[f64; 3]; 3]>);

impl Triangles {
    fn of(model: &PrintableModel) -> Self {
        Self(
            model
                .bodies()
                .iter()
                .flat_map(|b| b.mesh.triangles().iter().map(move |t| t.map(|i| b.mesh.vertices()[i as usize].map(mm))))
                .collect(),
        )
    }

    /// Distances along `dir` from `origin` to every surface it crosses.
    fn hits(&self, origin: [f64; 3], dir: [f64; 3]) -> Vec<f64> {
        self.0.iter().filter_map(|t| ray_triangle(origin, dir, t)).collect()
    }

    fn nearest(&self, origin: [f64; 3], dir: [f64; 3]) -> Option<f64> {
        self.hits(origin, dir).into_iter().reduce(f64::min)
    }

    /// Inside a closed solid: a ray from the point crosses its surface an odd
    /// number of times. Three rays vote, so one grazing ray cannot decide it.
    fn inside(&self, at: [f64; 3]) -> bool {
        let dirs = [[1.0, 1.0, 1.0], [-1.0, 2.0, 3.0], [1.0, -1.0, 0.0]].map(|d: [f64; 3]| {
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            d.map(|c| c / len)
        });
        dirs.iter().filter(|dir| self.hits(at, **dir).len() % 2 == 1).count() >= 2
    }
}

/// Möller and Trumbore: the distance along `dir` at which the ray meets `t`.
fn ray_triangle(origin: [f64; 3], dir: [f64; 3], t: &[[f64; 3]; 3]) -> Option<f64> {
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let (e1, e2) = (sub(t[1], t[0]), sub(t[2], t[0]));
    let p = cross(dir, e2);
    let det = dot(e1, p);
    if det.abs() < 1e-12 {
        return None;
    }
    let s = sub(origin, t[0]);
    let u = dot(s, p) / det;
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = cross(s, e1);
    let v = dot(dir, q) / det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let distance = dot(e2, q) / det;
    (distance > 1e-9).then_some(distance)
}

/// Rays in the plane across `axis` through `at`.
const HOLE_RAYS: usize = 72;

/// The diameter of the circle fitted (least squares) to where rays from `at`,
/// across the hole's axis, first meet its wall.
fn hole_diameter(triangles: &Triangles, at: [f64; 3], axis: Axis) -> Result<f64, String> {
    let (a, b) = match axis {
        Axis::X => (1, 2),
        Axis::Y => (2, 0),
        Axis::Z => (0, 1),
    };
    let mut points = Vec::with_capacity(HOLE_RAYS);
    for i in 0..HOLE_RAYS {
        let angle = std::f64::consts::TAU * (i as f64 + 0.25) / HOLE_RAYS as f64;
        let mut dir = [0.0; 3];
        dir[a] = angle.cos();
        dir[b] = angle.sin();
        let Some(r) = triangles.nearest(at, dir) else {
            return Err(format!("the hole around [{:.2}, {:.2}, {:.2}] is open to one side", at[0], at[1], at[2]));
        };
        points.push((at[a] + r * dir[a], at[b] + r * dir[b]));
    }
    // Kasa's fit: x² + y² + D x + E y + F = 0, solved by its normal equations.
    let n = points.len() as f64;
    let (mut sx, mut sy, mut sxx, mut syy, mut sxy, mut sz, mut sxz, mut syz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for &(x, y) in &points {
        let z = x * x + y * y;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
        sz += z;
        sxz += x * z;
        syz += y * z;
    }
    let m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    let rhs = [-sxz, -syz, -sz];
    let Some([d, e, f]) = solve3(m, rhs) else {
        return Err("the hole's wall is not round".into());
    };
    let (cx, cy) = (-d / 2.0, -e / 2.0);
    let r2 = cx * cx + cy * cy - f;
    if r2 <= 0.0 {
        return Err("the hole's wall is not round".into());
    }
    let r = r2.sqrt();
    let worst = points.iter().map(|(x, y)| (((x - cx).powi(2) + (y - cy).powi(2)).sqrt() - r).abs()).fold(0.0, f64::max);
    if worst > 0.05 * r + 0.05 {
        return Err(format!("the wall around the point is not a round hole (it strays {worst:.2} mm from a circle)"));
    }
    Ok(2.0 * r)
}

fn solve3(m: [[f64; 3]; 3], rhs: [f64; 3]) -> Option<[f64; 3]> {
    let det = |m: [[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let whole = det(m);
    if whole.abs() < 1e-12 {
        return None;
    }
    let mut out = [0.0; 3];
    for (k, slot) in out.iter_mut().enumerate() {
        let mut replaced = m;
        for row in 0..3 {
            replaced[row][k] = rhs[row];
        }
        *slot = det(replaced) / whole;
    }
    Some(out)
}

/// The thinnest chord through `at` over 13 lines (the axes, the face
/// diagonals, and the body diagonals of a cube), each from exit to exit.
fn wall_thickness(triangles: &Triangles, at: [f64; 3]) -> Option<f64> {
    let mut lines = Vec::new();
    for x in -1i32..=1 {
        for y in -1i32..=1 {
            for z in -1i32..=1 {
                // One direction of each line: the first nonzero component positive.
                let first = [x, y, z].into_iter().find(|c| *c != 0);
                if first == Some(1) {
                    let len = f64::from(x * x + y * y + z * z).sqrt();
                    lines.push([f64::from(x) / len, f64::from(y) / len, f64::from(z) / len]);
                }
            }
        }
    }
    lines
        .into_iter()
        .filter_map(|d| Some(triangles.nearest(at, d)? + triangles.nearest(at, d.map(|c| -c))?))
        .reduce(f64::min)
}
