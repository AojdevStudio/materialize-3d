//! Mesh to layers: the slicing half of the layer kernel, which judges any
//! printable model layer by layer for the advisory `print.*` checks.
//!
//! Every body is cut at the middle of each 0.2 mm layer and rasterized on one
//! shared grid of 0.1 mm pixels (coarser for a very large model, so the work
//! stays bounded). A plane never meets a vertex ambiguously: a vertex at the
//! sample height counts as below it. The cross-section is filled even-odd, so a
//! closed mesh gives its true section; an open one gives what it can, and the
//! geometry checks already fail it.
//!
//! From the layers:
//! - **overhang**: the part of a layer more than one layer height (45 degrees)
//!   plus one pixel away from everything printed in the layer below it;
//! - **minimum wall**: the part of a layer that a disk of [`MIN_WALL_MM`]
//!   cannot reach while staying inside the layer (an opening);
//! - **first-layer contact**: how much of a body touches the bed.

use super::super::model::{Body, PrintableModel};
use super::super::printer::Um;

/// Layer height of the P2S 0.20 mm Standard process, first layer included.
pub const LAYER_UM: Um = 200;
/// Finest pixel edge.
const PIXEL_UM: Um = 100;
/// Pixels per layer at most; a larger footprint gets coarser pixels.
const MAX_PIXELS: usize = 1_500_000;
/// An overhang steeper than 45 degrees from vertical is unsupported.
const OVERHANG_ALLOWANCE_UM: f64 = LAYER_UM as f64;
/// Narrower than this, a wall is thinner than one 0.4 mm nozzle line.
pub const MIN_WALL_MM: f64 = 0.4;

/// One body's cross-section at every layer, on the model's shared grid.
pub struct BodyLayers<'a> {
    pub body: &'a Body,
    /// Index of the body's first layer with material, if any.
    pub first: Option<usize>,
    layers: Vec<Bitmap>,
}

impl BodyLayers<'_> {
    pub fn layer(&self, index: usize) -> Option<&Bitmap> {
        self.layers.get(index)
    }
}

/// Every body of a model, sliced on one grid.
pub struct ModelLayers<'a> {
    pub grid: Grid,
    pub bodies: Vec<BodyLayers<'a>>,
}

/// The pixel grid shared by every layer of a model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Grid {
    /// Plate position of pixel (0, 0)'s lower corner, µm.
    pub origin: [Um; 2],
    pub pixel_um: Um,
    pub width: usize,
    pub height: usize,
    pub layers: usize,
}

impl Grid {
    pub fn pixel_area_mm2(&self) -> f64 {
        let mm = self.pixel_um as f64 / 1000.0;
        mm * mm
    }

    /// The bottom of layer `index`, mm.
    pub fn layer_bottom_mm(&self, index: usize) -> f64 {
        (index as Um * LAYER_UM) as f64 / 1000.0
    }
}

/// A set of pixels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bitmap {
    width: usize,
    bits: Vec<bool>,
}

impl Bitmap {
    fn empty(grid: &Grid) -> Self {
        Self { width: grid.width, bits: vec![false; grid.width * grid.height] }
    }

    pub fn count(&self) -> usize {
        self.bits.iter().filter(|b| **b).count()
    }

    fn and_not(&self, other: &Bitmap) -> Bitmap {
        Bitmap { width: self.width, bits: self.bits.iter().zip(&other.bits).map(|(a, b)| *a && !*b).collect() }
    }

    fn or(&self, other: &Bitmap) -> Bitmap {
        Bitmap { width: self.width, bits: self.bits.iter().zip(&other.bits).map(|(a, b)| *a || *b).collect() }
    }

    /// Pixels whose center lies within `radius_px` pixel edges of a set pixel.
    fn dilate(&self, radius_px: f64) -> Bitmap {
        let distance = squared_distance_to(self, true);
        let limit = radius_px * radius_px;
        Bitmap { width: self.width, bits: distance.iter().map(|d| *d <= limit).collect() }
    }

    /// Set pixels at least `radius_px` from every unset pixel.
    fn erode(&self, radius_px: f64) -> Bitmap {
        let distance = squared_distance_to(self, false);
        let limit = radius_px * radius_px;
        Bitmap { width: self.width, bits: self.bits.iter().zip(&distance).map(|(set, d)| *set && *d >= limit).collect() }
    }
}

/// Slices every body of `model` on one grid around the model's footprint.
pub fn slice(model: &PrintableModel) -> ModelLayers<'_> {
    let [lo, hi] = model.bounds();
    let span = [(hi[0] - lo[0]).max(1), (hi[1] - lo[1]).max(1)];
    let mut pixel_um = PIXEL_UM;
    while ((span[0] / pixel_um + 3) * (span[1] / pixel_um + 3)) as usize > MAX_PIXELS {
        pixel_um += PIXEL_UM;
    }
    let grid = Grid {
        origin: [lo[0] - pixel_um, lo[1] - pixel_um],
        pixel_um,
        width: (span[0] / pixel_um + 3) as usize,
        height: (span[1] / pixel_um + 3) as usize,
        layers: (hi[2].max(0) / LAYER_UM + 1) as usize,
    };
    let bodies = model
        .bodies()
        .iter()
        .map(|body| {
            let layers: Vec<Bitmap> = (0..grid.layers).map(|i| section(body, &grid, i)).collect();
            let first = layers.iter().position(|layer| layer.count() > 0);
            BodyLayers { body, first, layers }
        })
        .collect();
    ModelLayers { grid, bodies }
}

/// The body's cross-section at the middle of layer `index`, filled even-odd.
fn section(body: &Body, grid: &Grid, index: usize) -> Bitmap {
    let z = (index as Um * LAYER_UM + LAYER_UM / 2) as f64;
    let vertices = body.mesh.vertices();
    let mut segments: Vec<[[f64; 2]; 2]> = Vec::new();
    for t in body.mesh.triangles() {
        let p = t.map(|i| vertices[i as usize].map(|c| c as f64));
        let above = p.map(|v| v[2] > z);
        let crossing: Vec<[f64; 2]> = [(0, 1), (1, 2), (2, 0)]
            .into_iter()
            .filter(|&(a, b)| above[a] != above[b])
            .map(|(a, b)| {
                let t = (z - p[a][2]) / (p[b][2] - p[a][2]);
                [p[a][0] + t * (p[b][0] - p[a][0]), p[a][1] + t * (p[b][1] - p[a][1])]
            })
            .collect();
        if let [a, b] = crossing[..] {
            segments.push([a, b]);
        }
    }
    let mut bitmap = Bitmap::empty(grid);
    let size = grid.pixel_um as f64;
    let mut xs = Vec::new();
    for row in 0..grid.height {
        let y = grid.origin[1] as f64 + (row as f64 + 0.5) * size;
        xs.clear();
        for [a, b] in &segments {
            if (a[1] <= y) != (b[1] <= y) {
                xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
            }
        }
        xs.sort_by(f64::total_cmp);
        for pair in xs.as_chunks::<2>().0 {
            let to_col = |x: f64| ((x - grid.origin[0] as f64) / size - 0.5).ceil().max(0.0) as usize;
            for col in to_col(pair[0])..to_col(pair[1]).min(grid.width) {
                bitmap.bits[row * grid.width + col] = true;
            }
        }
    }
    bitmap
}

/// Squared distance, in pixel edges, from every pixel center to the nearest
/// pixel whose bit equals `to` (Felzenszwalb and Huttenlocher's exact
/// transform, one pass per axis).
fn squared_distance_to(bitmap: &Bitmap, to: bool) -> Vec<f64> {
    let (width, height) = (bitmap.width, bitmap.bits.len() / bitmap.width.max(1));
    // Far beyond any distance on a grid of at most a few thousand pixels a side,
    // and small enough that adding a squared index to it stays exact.
    const FAR: f64 = 1e12;
    let mut grid: Vec<f64> = bitmap.bits.iter().map(|b| if *b == to { 0.0 } else { FAR }).collect();
    let mut line = Vec::new();
    for col in 0..width {
        line.clear();
        line.extend((0..height).map(|row| grid[row * width + col]));
        let out = transform_1d(&line);
        for row in 0..height {
            grid[row * width + col] = out[row];
        }
    }
    for row in 0..height {
        let out = transform_1d(&grid[row * width..(row + 1) * width]);
        grid[row * width..(row + 1) * width].copy_from_slice(&out);
    }
    grid
}

fn transform_1d(f: &[f64]) -> Vec<f64> {
    let n = f.len();
    let mut d = vec![0.0; n];
    if n == 0 {
        return d;
    }
    // v: the parabolas of the lower envelope; z: where each one takes over.
    let mut v = vec![0usize; n];
    let mut z = vec![0.0f64; n + 1];
    let mut k = 0;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    let intersect = |q: usize, p: usize| ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2.0 * (q as f64 - p as f64));
    for q in 1..n {
        let mut s = intersect(q, v[k]);
        // z[0] is minus infinity, so this stops at k == 0 at the latest.
        while s <= z[k] {
            k -= 1;
            s = intersect(q, v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, out) in d.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let p = v[k];
        *out = (q as f64 - p as f64).powi(2) + f[p];
    }
    d
}

/// The largest unsupported area of one body's layers, and where.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Overhang {
    pub area_mm2: f64,
    pub z_mm: f64,
    /// Unsupported area summed over every layer above the first.
    pub total_mm2: f64,
}

/// Unsupported area of `body` per layer: material more than the 45-degree
/// allowance away from anything any body printed in the layer below. The
/// bed supports the first layer.
pub fn overhang(layers: &ModelLayers<'_>, body: usize) -> Overhang {
    let grid = &layers.grid;
    let allowance_px = OVERHANG_ALLOWANCE_UM / grid.pixel_um as f64 + 1.0;
    let mut worst = Overhang { area_mm2: 0.0, z_mm: 0.0, total_mm2: 0.0 };
    for index in 1..grid.layers {
        let Some(current) = layers.bodies[body].layer(index) else { continue };
        if current.count() == 0 {
            continue;
        }
        let below = layers
            .bodies
            .iter()
            .filter_map(|b| b.layer(index - 1))
            .fold(Bitmap::empty(grid), |union, layer| union.or(layer));
        // A layer inside the one below it needs no distance transform.
        if current.and_not(&below).count() == 0 {
            continue;
        }
        let unsupported = current.and_not(&below.dilate(allowance_px)).count() as f64 * grid.pixel_area_mm2();
        worst.total_mm2 += unsupported;
        if unsupported > worst.area_mm2 {
            worst.area_mm2 = unsupported;
            worst.z_mm = grid.layer_bottom_mm(index);
        }
    }
    worst
}

/// The largest area of one layer of `body` narrower than [`MIN_WALL_MM`], and where.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThinWall {
    pub area_mm2: f64,
    pub z_mm: f64,
}

pub fn thin_walls(layers: &ModelLayers<'_>, body: usize) -> ThinWall {
    let grid = &layers.grid;
    let radius_px = MIN_WALL_MM * 1000.0 / 2.0 / grid.pixel_um as f64;
    let mut worst = ThinWall { area_mm2: 0.0, z_mm: 0.0 };
    for index in 0..grid.layers {
        let Some(current) = layers.bodies[body].layer(index) else { continue };
        // A layer the same as the one below it has the same thin area.
        if current.count() == 0 || (index > 0 && layers.bodies[body].layer(index - 1) == Some(current)) {
            continue;
        }
        let opened = current.erode(radius_px).dilate(radius_px);
        let thin = current.and_not(&opened).count() as f64 * grid.pixel_area_mm2();
        if thin > worst.area_mm2 {
            worst = ThinWall { area_mm2: thin, z_mm: grid.layer_bottom_mm(index) };
        }
    }
    worst
}

/// How much of `body` touches the bed, and its largest layer, mm².
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Contact {
    pub bed_mm2: f64,
    pub largest_mm2: f64,
    /// The bottom of the body's first layer, mm; 0 when it rests on the bed.
    pub starts_mm: Option<f64>,
}

pub fn contact(layers: &ModelLayers<'_>, body: usize) -> Contact {
    let grid = &layers.grid;
    let body = &layers.bodies[body];
    let area = |layer: &Bitmap| layer.count() as f64 * grid.pixel_area_mm2();
    Contact {
        bed_mm2: body.layer(0).map_or(0.0, area),
        largest_mm2: body.layers.iter().map(area).fold(0.0, f64::max),
        starts_mm: body.first.map(|first| grid.layer_bottom_mm(first)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fabrication::model::{Mesh, Palette};
    use crate::fabrication::printer::P2S_04;

    /// A closed box from `lo` to `hi`, µm, outward.
    pub(crate) fn cuboid(lo: [Um; 3], hi: [Um; 3]) -> Mesh {
        let v: Vec<[Um; 3]> = (0..8)
            .map(|i| [if i & 1 == 0 { lo[0] } else { hi[0] }, if i & 2 == 0 { lo[1] } else { hi[1] }, if i & 4 == 0 { lo[2] } else { hi[2] }])
            .collect();
        let t = vec![[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]];
        Mesh::new(v, t).expect("mesh")
    }

    fn join(meshes: &[Mesh]) -> Mesh {
        let (mut v, mut t) = (Vec::new(), Vec::new());
        for mesh in meshes {
            let base = v.len() as u32;
            v.extend_from_slice(mesh.vertices());
            t.extend(mesh.triangles().iter().map(|tri| tri.map(|i| i + base)));
        }
        Mesh::new(v, t).expect("mesh")
    }

    fn model(mesh: Mesh) -> PrintableModel {
        let palette = Palette::new(vec!["#FFFFFF".into()], &P2S_04).expect("palette");
        let slot = palette.slot(0).expect("slot");
        PrintableModel::new("t".into(), palette, vec![Body { name: "b".into(), slot, mesh }]).expect("model")
    }

    #[test]
    fn a_box_slices_to_its_footprint_on_every_layer() {
        let model = model(cuboid([0, 0, 0], [10_000, 5_000, 2_000]));
        let layers = slice(&model);
        assert_eq!(layers.grid.layers, 11);
        let area = |i| layers.bodies[0].layer(i).expect("layer").count() as f64 * layers.grid.pixel_area_mm2();
        for i in 0..10 {
            assert!((area(i) - 50.0).abs() < 0.01, "layer {i}: {} mm²", area(i));
        }
        assert_eq!(area(10), 0.0, "the top face is below the last sample");
        assert_eq!(overhang(&layers, 0).area_mm2, 0.0);
        assert_eq!(thin_walls(&layers, 0).area_mm2, 0.0);
        assert_eq!(contact(&layers, 0), Contact { bed_mm2: area(0), largest_mm2: area(0), starts_mm: Some(0.0) });
    }

    /// A 40 x 40 mm slab on a 4 x 4 mm post: the slab's underside is a
    /// cantilever, 1600 - 16 mm² less the allowance ring.
    #[test]
    fn a_slab_on_a_post_overhangs_where_the_slab_begins() {
        let model = model(join(&[cuboid([18_000, 18_000, 0], [22_000, 22_000, 10_000]), cuboid([0, 0, 10_000], [40_000, 40_000, 13_000])]));
        let layers = slice(&model);
        let found = overhang(&layers, 0);
        assert!((found.z_mm - 10.0).abs() < 1e-9, "{found:?}");
        assert!(found.area_mm2 > 1_570.0 && found.area_mm2 < 1_584.0, "{found:?}");
    }

    /// A 45 degree chamfer is printable; a 60 degree one is not.
    #[test]
    fn a_wall_leaning_up_to_45_degrees_is_supported() {
        // Stack of boxes each 0.2 mm tall, stepping out by `step` µm per layer.
        let stairs = |step: Um| {
            let boxes: Vec<Mesh> = (0..20).map(|i| cuboid([0, 0, i * 200], [5_000 + i * step, 5_000, (i + 1) * 200])).collect();
            model(join(&boxes))
        };
        let (model_45, model_60) = (stairs(200), stairs(400));
        let layers_45 = slice(&model_45);
        assert_eq!(overhang(&layers_45, 0).area_mm2, 0.0);
        let layers_60 = slice(&model_60);
        assert!(overhang(&layers_60, 0).area_mm2 > 0.5, "{:?}", overhang(&layers_60, 0));
    }

    #[test]
    fn a_wall_thinner_than_one_line_is_thin() {
        let thin = model(join(&[cuboid([0, 0, 0], [10_000, 10_000, 1_000]), cuboid([0, 0, 1_000], [10_000, 200, 5_000])]));
        let found = thin_walls(&slice(&thin), 0);
        assert!(found.area_mm2 > 1.5, "a 0.2 mm wall: {found:?}");
        let thick = model(join(&[cuboid([0, 0, 0], [10_000, 10_000, 1_000]), cuboid([0, 0, 1_000], [10_000, 1_200, 5_000])]));
        assert_eq!(thin_walls(&slice(&thick), 0).area_mm2, 0.0, "a 1.2 mm wall");
    }

    #[test]
    fn a_body_that_starts_above_the_bed_has_no_contact() {
        let model = model(cuboid([0, 0, 1_000], [5_000, 5_000, 3_000]));
        let layers = slice(&model);
        let found = contact(&layers, 0);
        assert_eq!(found.bed_mm2, 0.0);
        assert_eq!(found.starts_mm, Some(1.0));
        assert!(overhang(&layers, 0).area_mm2 > 20.0, "the whole first layer floats");
    }

    #[test]
    fn the_distance_transform_is_exact() {
        let bitmap = Bitmap { width: 5, bits: vec![true, false, false, false, false] };
        assert_eq!(squared_distance_to(&bitmap, true), [0.0, 1.0, 4.0, 9.0, 16.0]);
        let mut bits = vec![false; 25];
        bits[12] = true;
        let distance = squared_distance_to(&Bitmap { width: 5, bits }, true);
        assert_eq!(distance[0], 8.0);
        assert_eq!(distance[13], 1.0);
    }
}
