//! Inline SVG artwork flattened into filled polygons on the finished face.
//!
//! v1 accepts solid-color fills only. Strokes, gradients, patterns, images,
//! text, clip paths, masks, filters and partial opacity are validation errors,
//! because each would need a geometric interpretation this module does not make.

use std::collections::BTreeMap;

use usvg::tiny_skia_path::{PathSegment, Point, Transform};
use usvg::{Group, Node, Paint};

use super::geometry::ContourBuilder;
use super::spec::{FillRule, InkIndex, SpecError, SvgFill};

/// Flattens every filled path of `source`, in paint order, with absolute
/// transforms applied. The SVG viewport is scaled to `w_mm` wide and placed
/// with its top-left corner at `origin`.
pub(crate) fn flatten(
    element: usize,
    source: &str,
    ink_map: &BTreeMap<String, InkIndex>,
    origin: [f64; 2],
    w_mm: f64,
) -> Result<Vec<SvgFill>, SpecError> {
    let unsupported = |reason: String| SpecError::Svg { element, reason };
    let document = usvg::roxmltree::Document::parse(source)
        .map_err(|e| unsupported(format!("svg_source is not valid XML: {e}")))?;
    // usvg drops `<text>` (its text feature is off) and any `<image>` it cannot
    // resolve without reporting an error, so both are rejected before parsing.
    if document
        .descendants()
        .any(|n| n.is_element() && matches!(n.tag_name().name(), "text" | "image"))
    {
        return Err(unsupported(
            "svg <text> and <image> are not supported; convert both to filled paths".into(),
        ));
    }
    let tree = usvg::Tree::from_str(source, &usvg::Options::default())
        .map_err(|e| unsupported(format!("svg_source does not parse: {e}")))?;
    let scale = w_mm / f64::from(tree.size().width());
    let walker = Walker {
        element,
        ink_map,
        origin,
        scale,
    };
    let mut fills = Vec::new();
    walker.group(tree.root(), &mut fills)?;
    if fills.is_empty() {
        return Err(unsupported("svg has no filled paths".into()));
    }
    Ok(fills)
}

struct Walker<'a> {
    element: usize,
    ink_map: &'a BTreeMap<String, InkIndex>,
    origin: [f64; 2],
    scale: f64,
}

impl Walker<'_> {
    fn unsupported(&self, reason: &str) -> SpecError {
        SpecError::Svg {
            element: self.element,
            reason: format!("svg {reason} is not supported"),
        }
    }

    fn group(&self, group: &Group, fills: &mut Vec<SvgFill>) -> Result<(), SpecError> {
        if group.clip_path().is_some() {
            return Err(self.unsupported("clip-path"));
        }
        if group.mask().is_some() {
            return Err(self.unsupported("mask"));
        }
        if !group.filters().is_empty() {
            return Err(self.unsupported("filter"));
        }
        if group.opacity().get() < 1.0 {
            return Err(self.unsupported("group opacity"));
        }
        for child in group.children() {
            match child {
                Node::Group(g) => self.group(g, fills)?,
                Node::Path(path) => {
                    if !path.is_visible() {
                        continue;
                    }
                    if path.stroke().is_some() {
                        return Err(SpecError::SvgStroke {
                            element: self.element,
                        });
                    }
                    let Some(fill) = path.fill() else { continue };
                    let Paint::Color(c) = fill.paint() else {
                        return Err(self.unsupported("gradient or pattern fill"));
                    };
                    if fill.opacity().get() < 1.0 {
                        return Err(self.unsupported("fill-opacity"));
                    }
                    let color = format!("#{:02x}{:02x}{:02x}", c.red, c.green, c.blue);
                    let ink =
                        *self
                            .ink_map
                            .get(&color)
                            .ok_or_else(|| SpecError::UnmappedSvgColor {
                                element: self.element,
                                color: color.clone(),
                            })?;
                    let rule = match fill.rule() {
                        usvg::FillRule::NonZero => FillRule::NonZero,
                        usvg::FillRule::EvenOdd => FillRule::EvenOdd,
                    };
                    let contours = self.contours(path.data(), path.abs_transform());
                    if !contours.is_empty() {
                        fills.push(SvgFill {
                            ink,
                            rule,
                            contours,
                        });
                    }
                }
                Node::Image(_) => return Err(self.unsupported("image")),
                Node::Text(_) => return Err(self.unsupported("text")),
            }
        }
        Ok(())
    }

    /// Control points are transformed before flattening (affine maps keep
    /// Béziers Béziers), so the flattening tolerance holds in millimeters.
    fn contours(&self, data: &usvg::tiny_skia_path::Path, ts: Transform) -> Vec<Vec<[f64; 2]>> {
        let map = |mut p: Point| {
            ts.map_point(&mut p);
            [
                self.origin[0] + f64::from(p.x) * self.scale,
                self.origin[1] + f64::from(p.y) * self.scale,
            ]
        };
        let mut builder = ContourBuilder::default();
        for segment in data.segments() {
            match segment {
                PathSegment::MoveTo(p) => builder.move_to(map(p)),
                PathSegment::LineTo(p) => builder.line_to(map(p)),
                PathSegment::QuadTo(c, p) => builder.quad_to(map(c), map(p)),
                PathSegment::CubicTo(c1, c2, p) => builder.cubic_to(map(c1), map(c2), map(p)),
                PathSegment::Close => builder.close(),
            }
        }
        builder.finish()
    }
}
