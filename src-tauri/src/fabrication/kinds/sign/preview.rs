//! Finished-face preview: the sign as a person reads it, in real colors.

use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Transform};

use super::geometry::{Shapes, SignLayout, UM_PER_MM};
use super::{Result, SignError};

/// PNG of the finished face at `px_per_mm`. Outside the outline is transparent.
pub fn render_preview(layout: &SignLayout, px_per_mm: f64) -> Result<Vec<u8>> {
    if !(px_per_mm.is_finite() && px_per_mm > 0.0) {
        return Err(SignError::Preview(format!(
            "px_per_mm {px_per_mm} must be positive"
        )));
    }
    let width = (layout.width_mm() * px_per_mm).round() as u32;
    let height = (layout.height_mm() * px_per_mm).round() as u32;
    let mut pixmap = Pixmap::new(width, height)
        .ok_or_else(|| SignError::Preview(format!("cannot allocate {width}x{height} px")))?;
    let scale = (px_per_mm / UM_PER_MM) as f32;

    let layers = std::iter::once((&layout.outline, &layout.palette[0]))
        .chain(layout.face.iter().zip(&layout.palette).skip(1));
    for (shapes, ink) in layers {
        let Some(path) = path(shapes, scale) else {
            continue;
        };
        let mut paint = Paint::default();
        paint.set_color(Color::from_rgba8(ink.rgb[0], ink.rgb[1], ink.rgb[2], 255));
        paint.anti_alias = true;
        pixmap.fill_path(
            &path,
            &paint,
            FillRule::EvenOdd,
            Transform::identity(),
            None,
        );
    }
    pixmap
        .encode_png()
        .map_err(|e| SignError::Preview(format!("png encoding failed: {e}")))
}

fn path(shapes: &Shapes, scale: f32) -> Option<tiny_skia::Path> {
    let mut builder = PathBuilder::new();
    for ring in shapes.iter().flatten() {
        let mut points = ring
            .iter()
            .map(|p| (p.x as f32 * scale, p.y as f32 * scale));
        let Some((x, y)) = points.next() else {
            continue;
        };
        builder.move_to(x, y);
        for (x, y) in points {
            builder.line_to(x, y);
        }
        builder.close();
    }
    builder.finish()
}
