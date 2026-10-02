//! Painting, planar partition and body construction.
//!
//! Planar work happens on a 1 µm integer grid (`P`), so booleans are exact up
//! to i_overlay's rounding of proper crossings, and every later comparison
//! (edge matching, on-segment tests, areas) is exact integer arithmetic.

use i_overlay::core::extract::BooleanExtractionBuffer;
use i_overlay::core::fill_rule::FillRule as OverlayFill;
use i_overlay::core::overlay::Overlay;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::i_float::int::point::IntPoint;

use super::font;
use super::mesh::{self, MeshBuilder};
use super::spec::{Contour, FillRule, InkIndex, ValidElement, ValidInk, ValidSignSpec};
use super::{Result, SignError};
use crate::fabrication::model::{Body, Palette, PrintableModel};
use crate::fabrication::printer::PrinterProfile;

/// A point on the 1 µm grid.
pub(crate) type P = IntPoint<i32>;
/// Closed ring without a repeated closing point.
pub(crate) type Ring = Vec<P>;
/// Outer ring first, then holes.
pub(crate) type Shape = Vec<Ring>;
pub(crate) type Shapes = Vec<Shape>;

/// Maximum distance between a curve and its flattened polyline.
pub(crate) const FLATTEN_TOLERANCE_MM: f64 = 0.01;
const MAX_CURVE_SEGMENTS: f64 = 256.0;
pub(crate) const UM_PER_MM: f64 = 1000.0;

/// Sign dimensions in µm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Dims {
    pub w: i32,
    pub h: i32,
    pub t: i32,
    pub d: i32,
}

/// Maps a finished-face point to model (bed) coordinates.
pub(crate) type ToModel = fn(P, Dims) -> P;

/// The one face-down transform: the finished face lies on the bed (z = 0) and
/// reads normally when viewed from below.
pub(crate) fn face_down(p: P, dims: Dims) -> P {
    P::new(dims.w - p.x, dims.h - p.y)
}

/// Built sign: finished-face regions (for preview and checks) and the
/// printable model, one closed body per filament in face-down bed coordinates.
#[derive(Debug, Clone)]
pub struct SignGeometry {
    pub(crate) dims: Dims,
    /// Analytic area of the (rounded) rectangle outline, mm².
    pub(crate) outline_area_mm2: f64,
    pub(crate) palette: Vec<ValidInk>,
    /// Finished-face outline, µm, y down.
    pub(crate) outline: Shapes,
    /// Finished-face region per palette index, µm, y down. Index 0 is the
    /// visible base (outline minus every ink); the rest are the inks.
    pub(crate) face: Vec<Shapes>,
    /// One body per palette index, in the same order, named after its ink.
    pub(crate) model: PrintableModel,
}

impl SignGeometry {
    pub fn width_mm(&self) -> f64 {
        mm(self.dims.w)
    }

    pub fn height_mm(&self) -> f64 {
        mm(self.dims.h)
    }

    pub fn thickness_mm(&self) -> f64 {
        mm(self.dims.t)
    }

    pub fn inlay_depth_mm(&self) -> f64 {
        mm(self.dims.d)
    }

    pub fn model(&self) -> &PrintableModel {
        &self.model
    }

    /// The printable model, for the check plan to certify.
    pub fn into_model(self) -> PrintableModel {
        self.model
    }
}

pub(crate) fn mm(um: i32) -> f64 {
    f64::from(um) / UM_PER_MM
}

fn um(mm: f64) -> i32 {
    (mm * UM_PER_MM).round() as i32
}

/// Builds the base body and one inlay body per ink.
///
/// Per ink, the region is the union of its elements minus every later element
/// of another ink or of the base, clipped to the outline. The base body is the
/// visible base (outline minus all inks) from 0 to the inlay depth plus the
/// full outline from the inlay depth to the thickness, as one closed mesh.
/// Body `i` prints in `printer`'s filament slot `i + 1`.
pub fn build_geometry(spec: &ValidSignSpec, printer: &PrinterProfile) -> Result<SignGeometry> {
    build_geometry_with(spec, printer, face_down)
}

pub(crate) fn build_geometry_with(spec: &ValidSignSpec, printer: &PrinterProfile, to_model: ToModel) -> Result<SignGeometry> {
    let dims = Dims {
        w: um(spec.width_mm),
        h: um(spec.height_mm),
        t: um(spec.thickness_mm),
        d: um(spec.inlay_depth_mm),
    };
    let radius = spec.corner_radius_mm.unwrap_or(0.0);
    let outline = normalize(
        &[rounded_rect(
            [0.0, 0.0],
            [spec.width_mm, spec.height_mm],
            radius,
        )],
        FillRule::NonZero,
    );

    let painted = paint(spec);
    let inks: Vec<Shapes> = painted
        .iter()
        .skip(1)
        .map(|region| boolean(&outline, region, OverlayRule::Intersect))
        .collect();
    let all_inks: Shapes = painted.into_iter().skip(1).flatten().collect();

    // The visible base, the covered area and the outline come out of ONE
    // overlay graph, so they share every split point on their common edges.
    let mut overlay = Overlay::from_subj_and_clip(&outline, &all_inks);
    let (visible_base, covered, outer) = match overlay.build_graph_view(OverlayFill::NonZero) {
        Some(graph) => {
            let mut buffer = BooleanExtractionBuffer::default();
            (
                graph.extract_shapes(OverlayRule::Difference, &mut buffer),
                graph.extract_shapes(OverlayRule::Intersect, &mut buffer),
                graph.extract_shapes(OverlayRule::Subject, &mut buffer),
            )
        }
        None => return Err(SignError::Geometry("sign outline is empty".into())),
    };

    let model = |shapes: &Shapes| to_model_space(shapes, dims, to_model);
    let mut meshes = Vec::with_capacity(spec.palette.len());
    let mut builder = MeshBuilder::default();
    mesh::base_body(
        &mut builder,
        model(&visible_base),
        model(&covered),
        model(&outer),
        dims,
    )?;
    meshes.push(builder);
    for region in &inks {
        let mut builder = MeshBuilder::default();
        mesh::inlay_body(&mut builder, &model(region), dims)?;
        meshes.push(builder);
    }

    let mut face = Vec::with_capacity(spec.palette.len());
    face.push(visible_base);
    face.extend(inks);
    Ok(SignGeometry {
        dims,
        outline_area_mm2: spec.width_mm * spec.height_mm
            - (4.0 - std::f64::consts::PI) * radius * radius,
        palette: spec.palette.clone(),
        outline,
        face,
        model: printable_model(spec, printer, meshes)?,
    })
}

/// The sign as a printable model: body `i` is palette entry `i`, printed in
/// filament slot `i + 1` (the base in slot 1).
fn printable_model(spec: &ValidSignSpec, printer: &PrinterProfile, meshes: Vec<MeshBuilder>) -> Result<PrintableModel> {
    let model_err = |e: crate::fabrication::model::ModelError| SignError::Geometry(e.to_string());
    let palette = Palette::new(spec.palette.iter().map(|ink| ink.hex.clone()).collect(), printer).map_err(model_err)?;
    let bodies = spec
        .palette
        .iter()
        .zip(meshes)
        .enumerate()
        .map(|(i, (ink, builder))| {
            let slot = palette.slot(i).ok_or_else(|| SignError::Geometry(format!("no filament slot for ink {:?}", ink.name)))?;
            Ok(Body { name: ink.name.clone(), slot, mesh: builder.into_mesh().map_err(model_err)? })
        })
        .collect::<Result<Vec<_>>>()?;
    PrintableModel::new(spec.title().to_owned(), palette, bodies).map_err(model_err)
}

/// Applies `to_model` to every point and restores outer-CCW / hole-CW order,
/// which a mirroring transform would flip.
fn to_model_space(shapes: &Shapes, dims: Dims, to_model: ToModel) -> Shapes {
    shapes
        .iter()
        .map(|shape| {
            shape
                .iter()
                .enumerate()
                .map(|(k, ring)| {
                    let mut ring: Ring = ring.iter().map(|&p| to_model(p, dims)).collect();
                    let outer = k == 0;
                    if (mesh::area2(&ring) > 0) != outer {
                        ring.reverse();
                    }
                    ring
                })
                .collect()
        })
        .collect()
}

/// Paints the elements in order. Returns one region per palette index; index 0
/// (the base) stays empty because base paint only removes ink.
fn paint(spec: &ValidSignSpec) -> Vec<Shapes> {
    let mut regions = vec![Shapes::new(); spec.palette.len()];
    for element in &spec.elements {
        for (ink, shape) in element_paint(element) {
            for (j, region) in regions.iter_mut().enumerate().skip(1) {
                if j != ink.0 && !region.is_empty() {
                    *region = boolean(region, &shape, OverlayRule::Difference);
                }
            }
            if !ink.is_base() {
                let region = &mut regions[ink.0];
                *region = boolean(region, &shape, OverlayRule::Union);
            }
        }
    }
    regions
}

/// The paint operations of one element, in order.
fn element_paint(element: &ValidElement) -> Vec<(InkIndex, Shapes)> {
    match element {
        ValidElement::Text {
            ink,
            text,
            font,
            cap_height_mm,
            x_mm,
            y_mm,
            align,
        } => {
            let contours = font::text_contours(*font, text, *cap_height_mm, [*x_mm, *y_mm], *align);
            vec![(*ink, normalize(&contours, FillRule::NonZero))]
        }
        ValidElement::Rect {
            ink,
            x_mm,
            y_mm,
            w_mm,
            h_mm,
            corner_radius_mm,
        } => {
            let contour = rounded_rect(
                [*x_mm, *y_mm],
                [*w_mm, *h_mm],
                corner_radius_mm.unwrap_or(0.0),
            );
            vec![(*ink, normalize(&[contour], FillRule::NonZero))]
        }
        ValidElement::Svg { fills, .. } => fills
            .iter()
            .map(|fill| (fill.ink, normalize(&fill.contours, fill.rule)))
            .collect(),
    }
}

fn boolean(subject: &Shapes, clip: &Shapes, rule: OverlayRule) -> Shapes {
    Overlay::from_subj_and_clip(subject, clip).overlay(rule, OverlayFill::NonZero)
}

/// Snaps contours to the µm grid and resolves them into simple shapes.
fn normalize(contours: &[Contour], rule: FillRule) -> Shapes {
    let rings: Vec<Ring> = contours
        .iter()
        .map(|c| {
            let mut ring: Ring = c.iter().map(|&[x, y]| P::new(um(x), um(y))).collect();
            ring.dedup();
            while ring.len() > 1 && ring.first() == ring.last() {
                ring.pop();
            }
            ring
        })
        .filter(|ring| ring.len() >= 3)
        .collect();
    if rings.is_empty() {
        return Shapes::new();
    }
    let fill = match rule {
        FillRule::NonZero => OverlayFill::NonZero,
        FillRule::EvenOdd => OverlayFill::EvenOdd,
    };
    Overlay::from_subj(&rings).overlay(OverlayRule::Subject, fill)
}

/// Rectangle with optional round corners, as a polygon in millimeters.
pub(crate) fn rounded_rect([x, y]: [f64; 2], [w, h]: [f64; 2], r: f64) -> Contour {
    if r <= 0.0 {
        return vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    }
    let segments = arc_segments(r, std::f64::consts::FRAC_PI_2);
    let corners = [
        ([x + w - r, y + r], -std::f64::consts::FRAC_PI_2),
        ([x + w - r, y + h - r], 0.0),
        ([x + r, y + h - r], std::f64::consts::FRAC_PI_2),
        ([x + r, y + r], std::f64::consts::PI),
    ];
    let mut contour = Vec::with_capacity(4 * (segments + 1));
    for ([cx, cy], start) in corners {
        for i in 0..=segments {
            let a = start + std::f64::consts::FRAC_PI_2 * i as f64 / segments as f64;
            contour.push([cx + r * a.cos(), cy + r * a.sin()]);
        }
    }
    contour
}

/// Segment count that keeps an arc of radius `r` within the tolerance.
fn arc_segments(r: f64, sweep: f64) -> usize {
    let step = 2.0 * (1.0 - FLATTEN_TOLERANCE_MM / r).clamp(-1.0, 1.0).acos();
    ((sweep / step).ceil() as usize).clamp(1, MAX_CURVE_SEGMENTS as usize)
}

/// Collects flattened contours from move/line/quad/cubic commands, subdividing
/// curves uniformly with a fixed tolerance so output is deterministic.
#[derive(Debug, Default)]
pub(crate) struct ContourBuilder {
    contours: Vec<Contour>,
    current: Contour,
}

impl ContourBuilder {
    pub fn move_to(&mut self, p: [f64; 2]) {
        self.close();
        self.current.push(p);
    }

    pub fn line_to(&mut self, p: [f64; 2]) {
        self.current.push(p);
    }

    pub fn quad_to(&mut self, c: [f64; 2], p: [f64; 2]) {
        let Some(&p0) = self.current.last() else {
            return;
        };
        // Chord error of a uniform step h is |p0 - 2c + p| h² / 4.
        let n = segments(norm(sub(add(p0, p), scale(c, 2.0))) / 4.0);
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            self.current.push(add(
                add(scale(p0, u * u), scale(c, 2.0 * u * t)),
                scale(p, t * t),
            ));
        }
    }

    pub fn cubic_to(&mut self, c1: [f64; 2], c2: [f64; 2], p: [f64; 2]) {
        let Some(&p0) = self.current.last() else {
            return;
        };
        // |B''| <= 6 max(|p0 - 2c1 + c2|, |c1 - 2c2 + p|); chord error <= |B''| h² / 8.
        let dd = norm(sub(add(p0, c2), scale(c1, 2.0))).max(norm(sub(add(c1, p), scale(c2, 2.0))));
        let n = segments(dd * 6.0 / 8.0);
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let u = 1.0 - t;
            let point = add(
                add(scale(p0, u * u * u), scale(c1, 3.0 * u * u * t)),
                add(scale(c2, 3.0 * u * t * t), scale(p, t * t * t)),
            );
            self.current.push(point);
        }
    }

    pub fn close(&mut self) {
        let contour = std::mem::take(&mut self.current);
        if contour.len() >= 3 {
            self.contours.push(contour);
        }
    }

    pub fn finish(mut self) -> Vec<Contour> {
        self.close();
        self.contours
    }
}

/// Uniform subdivision count for a curve whose chord error at step h is k h².
fn segments(k: f64) -> usize {
    (k / FLATTEN_TOLERANCE_MM)
        .sqrt()
        .ceil()
        .clamp(1.0, MAX_CURVE_SEGMENTS) as usize
}

fn add(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] + b[0], a[1] + b[1]]
}

fn sub(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

fn scale(a: [f64; 2], s: f64) -> [f64; 2] {
    [a[0] * s, a[1] * s]
}

fn norm(a: [f64; 2]) -> f64 {
    a[0].hypot(a[1])
}
