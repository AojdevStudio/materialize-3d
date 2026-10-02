//! Closed prism meshes from planar shapes.
//!
//! Caps are triangulated with earcut, which adds no Steiner points. Earcut
//! does drop collinear vertices, which would leave T-junctions against the
//! wall edges built from the same rings, so every cap goes through an exact
//! repair pass that splits triangles at dropped ring vertices, then an exact
//! check that the cap covers its shape and uses every ring edge once.

use std::collections::{HashMap, HashSet};

use super::geometry::{Dims, Shape, Shapes, P};
use super::{Result, SignError};
use crate::fabrication::model::{Mesh, ModelError};

const MAX_REPAIR_PASSES: usize = 64;

/// Twice the signed area of a ring (positive = counterclockwise), µm².
pub(crate) fn area2(ring: &[P]) -> i64 {
    let n = ring.len();
    (0..n)
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % n]);
            i64::from(a.x) * i64::from(b.y) - i64::from(b.x) * i64::from(a.y)
        })
        .sum()
}

fn tri_area2([a, b, c]: [P; 3]) -> i64 {
    cross(a, b, c)
}

/// (b - a) x (c - a)
fn cross(a: P, b: P, c: P) -> i64 {
    let (abx, aby) = (
        i64::from(b.x) - i64::from(a.x),
        i64::from(b.y) - i64::from(a.y),
    );
    let (acx, acy) = (
        i64::from(c.x) - i64::from(a.x),
        i64::from(c.y) - i64::from(a.y),
    );
    abx * acy - aby * acx
}

/// True when `v` lies on segment `ab`, excluding the endpoints.
fn strictly_inside(a: P, b: P, v: P) -> bool {
    if cross(a, b, v) != 0 || v == a || v == b {
        return false;
    }
    let dot = |p: P, q: P, r: P| {
        (i64::from(q.x) - i64::from(p.x)) * (i64::from(r.x) - i64::from(p.x))
            + (i64::from(q.y) - i64::from(p.y)) * (i64::from(r.y) - i64::from(p.y))
    };
    dot(a, b, v) > 0 && dot(b, a, v) > 0
}

/// Points sorted by x for range queries along segments.
struct PointIndex(Vec<P>);

impl PointIndex {
    fn new(points: impl IntoIterator<Item = P>) -> Self {
        let mut points: Vec<P> = points.into_iter().collect();
        points.sort_unstable_by_key(|p| (p.x, p.y));
        points.dedup();
        Self(points)
    }

    /// Points strictly inside segment `ab`, ordered from `a` to `b`.
    fn on_segment(&self, a: P, b: P) -> Vec<P> {
        let (x0, x1) = (a.x.min(b.x), a.x.max(b.x));
        let (y0, y1) = (a.y.min(b.y), a.y.max(b.y));
        let start = self.0.partition_point(|p| p.x < x0);
        let mut hits: Vec<P> = self.0[start..]
            .iter()
            .take_while(|p| p.x <= x1)
            .filter(|p| p.y >= y0 && p.y <= y1 && strictly_inside(a, b, **p))
            .copied()
            .collect();
        let dist = |p: &P| {
            (i64::from(p.x) - i64::from(a.x)).abs() + (i64::from(p.y) - i64::from(a.y)).abs()
        };
        hits.sort_by_key(dist);
        hits
    }
}

/// Inserts into every ring each vertex (of any ring in `sets`) that lies
/// strictly inside one of its edges. Afterwards, rings that share a boundary
/// stretch carry identical vertex sequences along it.
fn refine(sets: &mut [&mut Shapes]) {
    let index = PointIndex::new(
        sets.iter()
            .flat_map(|shapes| shapes.iter().flatten().flatten().copied()),
    );
    for shapes in sets.iter_mut() {
        for ring in shapes.iter_mut().flatten() {
            let n = ring.len();
            let mut refined = Vec::with_capacity(n);
            for i in 0..n {
                let (a, b) = (ring[i], ring[(i + 1) % n]);
                refined.push(a);
                refined.extend(index.on_segment(a, b));
            }
            *ring = refined;
        }
    }
}

fn ring_edges(ring: &[P]) -> impl Iterator<Item = (P, P)> + '_ {
    let n = ring.len();
    (0..n).map(move |i| (ring[i], ring[(i + 1) % n]))
}

fn tri_edges(t: [P; 3]) -> [(P, P); 3] {
    [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])]
}

/// Counterclockwise triangles exactly covering `shape` (outer CCW, holes CW),
/// using every ring vertex and every ring edge.
pub(crate) fn triangulate(shape: &Shape) -> Result<Vec<[P; 3]>> {
    let points: Vec<P> = shape.iter().flatten().copied().collect();
    let coords: Vec<f64> = points
        .iter()
        .flat_map(|p| [f64::from(p.x), f64::from(p.y)])
        .collect();
    let mut holes = Vec::with_capacity(shape.len().saturating_sub(1));
    let mut start = 0;
    for ring in &shape[..shape.len() - 1] {
        start += ring.len();
        holes.push(start);
    }
    let indices = earcutr::earcut(&coords, &holes, 2)
        .map_err(|e| SignError::Geometry(format!("earcut failed: {e:?}")))?;
    let mut tris: Vec<[P; 3]> = indices
        .as_chunks::<3>()
        .0
        .iter()
        .map(|c| c.map(|i| points[i]))
        .filter_map(|t| match tri_area2(t) {
            0 => None,
            a if a < 0 => Some([t[0], t[2], t[1]]),
            _ => Some(t),
        })
        .collect();

    let boundary: HashSet<(P, P)> = shape.iter().flat_map(|r| ring_edges(r)).collect();
    let index = PointIndex::new(points.iter().copied());
    repair_t_junctions(&mut tris, &boundary, &index);
    verify_cap(shape, &tris, &boundary)?;
    Ok(tris)
}

/// Splits triangles whose edge has neither a twin nor a boundary match at the
/// ring vertex lying inside that edge, until no such edge remains.
fn repair_t_junctions(tris: &mut Vec<[P; 3]>, boundary: &HashSet<(P, P)>, index: &PointIndex) {
    for _ in 0..MAX_REPAIR_PASSES {
        let edges: HashSet<(P, P)> = tris.iter().flat_map(|t| tri_edges(*t)).collect();
        let mut changed = false;
        let mut repaired = Vec::with_capacity(tris.len() + 8);
        for &t in tris.iter() {
            let split = (0..3).find_map(|k| {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                if edges.contains(&(b, a)) || boundary.contains(&(a, b)) {
                    return None;
                }
                index.on_segment(a, b).first().map(|&v| (k, v))
            });
            match split {
                Some((k, v)) => {
                    let (a, b, c) = (t[k], t[(k + 1) % 3], t[(k + 2) % 3]);
                    repaired.push([a, v, c]);
                    repaired.push([v, b, c]);
                    changed = true;
                }
                None => repaired.push(t),
            }
        }
        *tris = repaired;
        if !changed {
            return;
        }
    }
}

/// Exact check: triangle areas sum to the shape area, every directed edge is
/// used once, interior edges pair up, and every ring edge is on the cap boundary.
fn verify_cap(shape: &Shape, tris: &[[P; 3]], boundary: &HashSet<(P, P)>) -> Result<()> {
    let fail = |what: String| {
        let bbox = shape[0]
            .iter()
            .fold((i32::MAX, i32::MAX, i32::MIN, i32::MIN), |b, p| {
                (b.0.min(p.x), b.1.min(p.y), b.2.max(p.x), b.3.max(p.y))
            });
        Err(SignError::Geometry(format!(
            "cap triangulation of shape with bbox {bbox:?} µm and {} holes: {what}",
            shape.len() - 1
        )))
    };
    let expected: i64 = shape.iter().map(|r| area2(r)).sum();
    let actual: i64 = tris.iter().map(|t| tri_area2(*t)).sum();
    if expected != actual {
        return fail(format!("area {actual} != {expected} (2x µm²)"));
    }
    let mut edges = HashSet::with_capacity(tris.len() * 3);
    for t in tris {
        if tri_area2(*t) <= 0 {
            return fail("non-positive triangle".into());
        }
        for e in tri_edges(*t) {
            if !edges.insert(e) {
                return fail(format!("edge {e:?} used twice"));
            }
        }
    }
    for &(a, b) in &edges {
        if !edges.contains(&(b, a)) && !boundary.contains(&(a, b)) {
            return fail(format!("unmatched edge {:?}", (a, b)));
        }
    }
    if let Some(e) = boundary.iter().find(|e| !edges.contains(e)) {
        return fail(format!("ring edge {e:?} missing"));
    }
    Ok(())
}

/// Accumulates one body's triangles on a shared, deduplicated vertex list.
#[derive(Debug, Default)]
pub(crate) struct MeshBuilder {
    vertices: Vec<[i32; 3]>,
    lookup: HashMap<[i32; 3], u32>,
    triangles: Vec<[u32; 3]>,
}

impl MeshBuilder {
    fn vertex(&mut self, p: P, z: i32) -> u32 {
        let key = [p.x, p.y, z];
        *self.lookup.entry(key).or_insert_with(|| {
            self.vertices.push(key);
            u32::try_from(self.vertices.len() - 1).expect("vertex count fits u32")
        })
    }

    fn triangle(&mut self, [a, b, c]: [P; 3], z: [i32; 3]) {
        let t = [
            self.vertex(a, z[0]),
            self.vertex(b, z[1]),
            self.vertex(c, z[2]),
        ];
        self.triangles.push(t);
    }

    /// Horizontal faces at `z`; `up` selects the +z normal.
    fn cap(&mut self, shapes: &Shapes, z: i32, up: bool) -> Result<()> {
        for shape in shapes {
            for [a, b, c] in triangulate(shape)? {
                let t = if up { [a, b, c] } else { [a, c, b] };
                self.triangle(t, [z; 3]);
            }
        }
        Ok(())
    }

    /// Vertical faces from `z0` to `z1` along every ring, facing to the right of
    /// the ring direction (outward for outer-CCW / hole-CW rings).
    fn walls(&mut self, shapes: &Shapes, z0: i32, z1: i32) {
        for ring in shapes.iter().flatten() {
            for (a, b) in ring_edges(ring) {
                self.triangle([a, b, b], [z0, z0, z1]);
                self.triangle([a, b, a], [z0, z1, z1]);
            }
        }
    }

    pub(crate) fn into_mesh(self) -> Result<Mesh, ModelError> {
        Mesh::new(self.vertices.into_iter().map(|v| v.map(i64::from)).collect(), self.triangles)
    }
}

/// Base body: `visible` x [0, d] plus `outer` x [d, t], closed as one mesh.
/// `covered` (outline minus visible base) is the downward ceiling at z = d.
/// The three shape sets come from one overlay graph and are refined together,
/// so step walls, bottom holes, ceiling and outer walls share ring vertices.
pub(crate) fn base_body(
    mesh: &mut MeshBuilder,
    mut visible: Shapes,
    mut covered: Shapes,
    mut outer: Shapes,
    dims: Dims,
) -> Result<()> {
    refine(&mut [&mut visible, &mut covered, &mut outer]);
    mesh.cap(&visible, 0, false)?;
    mesh.cap(&covered, dims.d, false)?;
    mesh.cap(&outer, dims.t, true)?;
    mesh.walls(&visible, 0, dims.d);
    mesh.walls(&outer, dims.d, dims.t);
    Ok(())
}

/// Inlay body: `region` x [0, d].
pub(crate) fn inlay_body(mesh: &mut MeshBuilder, region: &Shapes, dims: Dims) -> Result<()> {
    mesh.cap(region, 0, false)?;
    mesh.cap(region, dims.d, true)?;
    mesh.walls(region, 0, dims.d);
    Ok(())
}
