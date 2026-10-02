//! The inspection guest's mesh protocol and the host's checks on it.
//!
//! `decode_mesh` bounds-checks before it allocates: body count, per-body vertex and triangle counts against both
//! the limits and the bytes actually present, finite coordinates within range, and in-range indices. `weld` snaps
//! every vertex to the 1 um grid and merges equal points; `analyze` then reports what the app's
//! `geometry.closed_manifold`, `non_degenerate`, and `outward_orientation` checks would see.
//!
//! Layout, little endian: b"M3DMESH1", u32 body count, then per body u32 vertex count, u32 triangle count,
//! vertex count * 3 f64 (mm), triangle count * 3 u32 indices.

use std::collections::HashMap;

use serde::Serialize;

const MAGIC: &[u8; 8] = b"M3DMESH1";
/// Vertices snap to this grid (1 um), the resolution the app's mesh checks work at.
pub const GRID_PER_MM: f64 = 1000.0;

#[derive(Clone, Copy, Debug)]
pub struct MeshLimits {
    pub max_bodies: u32,
    pub max_vertices: u32,
    pub max_triangles: u32,
    /// Largest absolute coordinate accepted, in mm.
    pub max_abs_mm: f64,
}

impl MeshLimits {
    pub const SPIKE: Self = Self {
        max_bodies: 16,
        max_vertices: 2_000_000,
        max_triangles: 2_000_000,
        max_abs_mm: 2_000.0,
    };
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum MeshError {
    #[error("mesh does not start with the M3DMESH1 magic")]
    BadMagic,
    #[error("mesh ends early")]
    Truncated,
    #[error("mesh has {0} bodies; 1 to the limit are allowed")]
    BodyCount(u32),
    #[error("body {body} claims {vertices} vertices and {triangles} triangles, over the limits")]
    TooLarge {
        body: u32,
        vertices: u32,
        triangles: u32,
    },
    #[error("body {body} declares no geometry ({vertices} vertices, {triangles} triangles)")]
    EmptyBody {
        body: u32,
        vertices: u32,
        triangles: u32,
    },
    #[error("body {body} claims more data than the mesh holds")]
    CountsExceedPayload { body: u32 },
    #[error("body {body} vertex {vertex} is not finite or is out of range")]
    BadCoordinate { body: u32, vertex: u32 },
    #[error("body {body} triangle {triangle} indexes past its vertices")]
    BadIndex { body: u32, triangle: u32 },
    #[error("{0} bytes follow the last body")]
    TrailingBytes(usize),
}

/// One body as the inspector sent it: per-face vertices, not yet welded.
#[derive(Debug)]
pub struct RawBody {
    pub vertices: Vec<[f64; 3]>,
    pub triangles: Vec<[u32; 3]>,
}

struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], MeshError> {
        if self.0.len() < n {
            return Err(MeshError::Truncated);
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn u32(&mut self) -> Result<u32, MeshError> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }
}

/// Decodes and bounds-checks the inspector's mesh. Allocation never exceeds what the payload actually holds.
pub fn decode_mesh(bytes: &[u8], limits: &MeshLimits) -> Result<Vec<RawBody>, MeshError> {
    let mut cur = Cursor(bytes);
    if cur.take(MAGIC.len())? != MAGIC {
        return Err(MeshError::BadMagic);
    }
    let count = cur.u32()?;
    if count == 0 || count > limits.max_bodies {
        return Err(MeshError::BodyCount(count));
    }
    let mut bodies = Vec::with_capacity(count as usize);
    for body in 0..count {
        let (vertices, triangles) = (cur.u32()?, cur.u32()?);
        if vertices > limits.max_vertices || triangles > limits.max_triangles {
            return Err(MeshError::TooLarge {
                body,
                vertices,
                triangles,
            });
        }
        if vertices == 0 || triangles == 0 {
            return Err(MeshError::EmptyBody {
                body,
                vertices,
                triangles,
            });
        }
        let need = u64::from(vertices) * 24 + u64::from(triangles) * 12;
        if need > cur.0.len() as u64 {
            return Err(MeshError::CountsExceedPayload { body });
        }
        let (coords, _) = cur.take(vertices as usize * 24)?.as_chunks::<24>();
        let mut verts = Vec::with_capacity(vertices as usize);
        for (vertex, chunk) in (0u32..).zip(coords) {
            let (parts, _) = chunk.as_chunks::<8>();
            let p: [f64; 3] = std::array::from_fn(|k| f64::from_le_bytes(parts[k]));
            if !p
                .iter()
                .all(|c| c.is_finite() && c.abs() <= limits.max_abs_mm)
            {
                return Err(MeshError::BadCoordinate { body, vertex });
            }
            verts.push(p);
        }
        let (raw, _) = cur.take(triangles as usize * 12)?.as_chunks::<12>();
        let mut tris = Vec::with_capacity(triangles as usize);
        for (triangle, chunk) in (0u32..).zip(raw) {
            let (parts, _) = chunk.as_chunks::<4>();
            let t: [u32; 3] = std::array::from_fn(|k| u32::from_le_bytes(parts[k]));
            if t.iter().any(|&i| i >= vertices) {
                return Err(MeshError::BadIndex { body, triangle });
            }
            tris.push(t);
        }
        bodies.push(RawBody {
            vertices: verts,
            triangles: tris,
        });
    }
    if !cur.0.is_empty() {
        return Err(MeshError::TrailingBytes(cur.0.len()));
    }
    Ok(bodies)
}

/// A body on the 1 um grid with shared vertices: what the app would package and check.
#[derive(Debug)]
pub struct WeldedBody {
    pub vertices: Vec<[i64; 3]>,
    pub triangles: Vec<[u32; 3]>,
}

/// Snaps every vertex to the 1 um grid and merges vertices that land on the same grid point.
pub fn weld(body: &RawBody) -> WeldedBody {
    let mut index: HashMap<[i64; 3], u32> = HashMap::with_capacity(body.vertices.len());
    let mut vertices = Vec::new();
    let remap: Vec<u32> = body
        .vertices
        .iter()
        .map(|p| {
            // Coordinates are finite and bounded by decode_mesh, so the rounded value fits i64.
            let q = p.map(|c| (c * GRID_PER_MM).round() as i64);
            *index.entry(q).or_insert_with(|| {
                vertices.push(q);
                (vertices.len() - 1) as u32
            })
        })
        .collect();
    let triangles = body
        .triangles
        .iter()
        .map(|t| t.map(|i| remap[i as usize]))
        .collect();
    WeldedBody {
        vertices,
        triangles,
    }
}

/// What the app's geometry checks would conclude about one welded body.
#[derive(Debug, Serialize)]
pub struct MeshReport {
    pub vertices: usize,
    pub triangles: usize,
    /// Triangles with two corners on the same grid point after snapping.
    pub collapsed_triangles: usize,
    /// Triangles whose three distinct corners are collinear on the grid.
    pub zero_area_triangles: usize,
    /// Edges used by exactly one triangle.
    pub boundary_edges: usize,
    /// Edges used by more than two triangles, or twice in the same direction.
    pub non_manifold_edges: usize,
    pub closed_manifold: bool,
    pub non_degenerate: bool,
    pub signed_volume_mm3: f64,
    pub outward: bool,
    pub bbox_min_mm: [f64; 3],
    pub bbox_max_mm: [f64; 3],
}

pub fn analyze(body: &WeldedBody) -> MeshReport {
    let v = &body.vertices;
    let has_surface = !body.triangles.is_empty();
    let mut collapsed = 0;
    let mut zero_area = 0;
    // Undirected edge -> (uses as low->high, uses as high->low).
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    let mut six_volume: i128 = 0;
    for &[a, b, c] in &body.triangles {
        if a == b || b == c || a == c {
            collapsed += 1;
            continue;
        }
        let (pa, pb, pc) = (v[a as usize], v[b as usize], v[c as usize]);
        let (u, w) = (sub(pb, pa), sub(pc, pa));
        let n = cross(u, w);
        if n == [0, 0, 0] {
            zero_area += 1;
        }
        six_volume += dot(pa, cross(pb.map(i128::from), pc.map(i128::from)));
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let entry = edges.entry((x.min(y), x.max(y))).or_default();
            if x < y {
                entry.0 += 1;
            } else {
                entry.1 += 1;
            }
        }
    }
    let boundary = edges.values().filter(|&&(f, r)| f + r == 1).count();
    let non_manifold = edges
        .values()
        .filter(|&&(f, r)| f + r > 1 && (f, r) != (1, 1))
        .count();
    let um3_per_mm3 = GRID_PER_MM.powi(3);
    let signed_volume_mm3 = six_volume as f64 / 6.0 / um3_per_mm3;
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for p in v {
        for k in 0..3 {
            let c = p[k] as f64 / GRID_PER_MM;
            lo[k] = lo[k].min(c);
            hi[k] = hi[k].max(c);
        }
    }
    MeshReport {
        vertices: v.len(),
        triangles: body.triangles.len(),
        collapsed_triangles: collapsed,
        zero_area_triangles: zero_area,
        boundary_edges: boundary,
        non_manifold_edges: non_manifold,
        // A body with no triangles has no surface, so neither verdict can hold for it.
        closed_manifold: has_surface && boundary == 0 && non_manifold == 0 && collapsed == 0,
        non_degenerate: has_surface && collapsed == 0 && zero_area == 0,
        signed_volume_mm3,
        outward: signed_volume_mm3 > 0.0,
        bbox_min_mm: lo,
        bbox_max_mm: hi,
    }
}

fn sub(a: [i64; 3], b: [i64; 3]) -> [i128; 3] {
    std::array::from_fn(|k| i128::from(a[k]) - i128::from(b[k]))
}

fn cross(a: [i128; 3], b: [i128; 3]) -> [i128; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [i64; 3], b: [i128; 3]) -> i128 {
    (0..3).map(|k| i128::from(a[k]) * b[k]).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A closed, outward tetrahedron with per-face vertices, the way the inspector sends faces.
    fn tetra_bytes(edit: impl FnOnce(&mut Vec<[f64; 3]>, &mut Vec<[u32; 3]>)) -> Vec<u8> {
        let p = [
            [0.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0],
        ];
        let faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
        let mut verts = Vec::new();
        let mut tris = Vec::new();
        for f in faces {
            let base = verts.len() as u32;
            verts.extend(f.map(|i| p[i]));
            tris.push([base, base + 1, base + 2]);
        }
        edit(&mut verts, &mut tris);
        encode(&[(verts, tris)])
    }

    /// One body's vertices and triangles, as the inspector would send them.
    type Body = (Vec<[f64; 3]>, Vec<[u32; 3]>);

    fn encode(bodies: &[Body]) -> Vec<u8> {
        let mut out = MAGIC.to_vec();
        out.extend((bodies.len() as u32).to_le_bytes());
        for (v, t) in bodies {
            out.extend((v.len() as u32).to_le_bytes());
            out.extend((t.len() as u32).to_le_bytes());
            v.iter().flatten().for_each(|c| out.extend(c.to_le_bytes()));
            t.iter().flatten().for_each(|i| out.extend(i.to_le_bytes()));
        }
        out
    }

    fn report(bytes: &[u8]) -> MeshReport {
        let bodies = decode_mesh(bytes, &MeshLimits::SPIKE).unwrap();
        analyze(&weld(&bodies[0]))
    }

    #[test]
    fn a_closed_outward_solid_passes_every_check() {
        let r = report(&tetra_bytes(|_, _| {}));
        assert_eq!(
            (r.vertices, r.triangles),
            (4, 4),
            "per-face vertices weld to 4"
        );
        assert!(r.closed_manifold && r.non_degenerate && r.outward, "{r:?}");
        assert!((r.signed_volume_mm3 - 1000.0 / 6.0).abs() < 1e-9);
    }

    #[test]
    fn an_open_mesh_reports_boundary_edges() {
        let r = report(&tetra_bytes(|_, t| {
            t.pop();
        }));
        assert_eq!(r.boundary_edges, 3);
        assert!(!r.closed_manifold);
    }

    #[test]
    fn a_flipped_face_is_not_a_closed_oriented_manifold() {
        let r = report(&tetra_bytes(|_, t| t[0].swap(1, 2)));
        assert!(r.non_manifold_edges > 0 && !r.closed_manifold, "{r:?}");
    }

    #[test]
    fn an_inside_out_solid_has_negative_volume() {
        let r = report(&tetra_bytes(|_, t| t.iter_mut().for_each(|f| f.swap(1, 2))));
        assert!(r.closed_manifold && !r.outward, "{r:?}");
    }

    #[test]
    fn snapping_collapses_a_sub_micron_sliver() {
        // A fifth triangle whose corners lie within 0.4 um of each other collapses on the grid.
        let r = report(&tetra_bytes(|v, t| {
            let base = v.len() as u32;
            v.extend([[5.0, 5.0, 5.0], [5.0004, 5.0, 5.0], [5.0, 5.0004, 5.0]]);
            t.push([base, base + 1, base + 2]);
        }));
        assert_eq!(r.collapsed_triangles, 1);
        assert!(!r.non_degenerate);
    }

    #[test]
    fn collinear_corners_are_zero_area() {
        let r = report(&tetra_bytes(|v, t| {
            let base = v.len() as u32;
            v.extend([[1.0, 1.0, 1.0], [2.0, 2.0, 2.0], [3.0, 3.0, 3.0]]);
            t.push([base, base + 1, base + 2]);
        }));
        assert_eq!(r.zero_area_triangles, 1);
    }

    #[test]
    fn hostile_meshes_are_rejected_before_use() {
        let lim = MeshLimits::SPIKE;
        let nan = tetra_bytes(|v, _| v[1][1] = f64::NAN);
        assert_eq!(
            decode_mesh(&nan, &lim).unwrap_err(),
            MeshError::BadCoordinate { body: 0, vertex: 1 }
        );
        let inf = tetra_bytes(|v, _| v[2][2] = f64::INFINITY);
        assert_eq!(
            decode_mesh(&inf, &lim).unwrap_err(),
            MeshError::BadCoordinate { body: 0, vertex: 2 }
        );
        let far = tetra_bytes(|v, _| v[0][0] = 1e300);
        assert_eq!(
            decode_mesh(&far, &lim).unwrap_err(),
            MeshError::BadCoordinate { body: 0, vertex: 0 }
        );
        let index = tetra_bytes(|_, t| t[3][2] = 99);
        assert_eq!(
            decode_mesh(&index, &lim).unwrap_err(),
            MeshError::BadIndex {
                body: 0,
                triangle: 3
            }
        );
        let mut trailing = tetra_bytes(|_, _| {});
        trailing.extend(b"EXTRA");
        assert_eq!(
            decode_mesh(&trailing, &lim).unwrap_err(),
            MeshError::TrailingBytes(5)
        );
        let mut magic = tetra_bytes(|_, _| {});
        magic[0] = b'X';
        assert_eq!(decode_mesh(&magic, &lim).unwrap_err(), MeshError::BadMagic);
        assert_eq!(
            decode_mesh(&encode(&[]), &lim).unwrap_err(),
            MeshError::BodyCount(0)
        );
        let seventeen: Vec<_> = (0..17)
            .map(|_| (vec![[0.0; 3]; 3], vec![[0, 1, 2]]))
            .collect();
        assert_eq!(
            decode_mesh(&encode(&seventeen), &lim).unwrap_err(),
            MeshError::BodyCount(17)
        );
    }

    #[test]
    fn a_declared_body_with_no_geometry_is_rejected() {
        let declared = |counts: [u32; 3], coords: &[f64]| {
            let mut bytes = MAGIC.to_vec();
            counts.iter().for_each(|n| bytes.extend(n.to_le_bytes()));
            coords.iter().for_each(|c| bytes.extend(c.to_le_bytes()));
            bytes
        };
        // One body, zero vertices, zero triangles: 20 bytes.
        let empty = declared([1, 0, 0], &[]);
        assert_eq!(empty.len(), 20);
        assert_eq!(
            decode_mesh(&empty, &MeshLimits::SPIKE).unwrap_err(),
            MeshError::EmptyBody {
                body: 0,
                vertices: 0,
                triangles: 0
            }
        );
        // Vertices but no triangles is no geometry either.
        let points = declared([1, 3, 0], &[0.0; 9]);
        assert_eq!(
            decode_mesh(&points, &MeshLimits::SPIKE).unwrap_err(),
            MeshError::EmptyBody {
                body: 0,
                vertices: 3,
                triangles: 0
            }
        );
        // A body built by hand without the decoder still gets no passing verdict.
        let r = analyze(&weld(&RawBody {
            vertices: Vec::new(),
            triangles: Vec::new(),
        }));
        assert!(
            !r.closed_manifold && !r.non_degenerate && !r.outward,
            "{r:?}"
        );
    }

    #[test]
    fn counts_are_checked_against_the_payload_before_allocating() {
        let mut lie = tetra_bytes(|_, _| {});
        lie[12..16].copy_from_slice(&1_999_999u32.to_le_bytes()); // within limits, far beyond the bytes present
        assert_eq!(
            decode_mesh(&lie, &MeshLimits::SPIKE).unwrap_err(),
            MeshError::CountsExceedPayload { body: 0 }
        );
        lie[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(
            decode_mesh(&lie, &MeshLimits::SPIKE).unwrap_err(),
            MeshError::TooLarge { .. }
        ));
        assert_eq!(
            decode_mesh(b"M3DMESH1\x01\x00", &MeshLimits::SPIKE).unwrap_err(),
            MeshError::Truncated
        );
    }
}
