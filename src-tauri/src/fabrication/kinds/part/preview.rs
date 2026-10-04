//! Orthographic views of any printable model: every triangle, flat-shaded in
//! its body's filament colour, drawn back to front.

use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Transform};

use crate::fabrication::kind::View;
use crate::fabrication::model::PrintableModel;

const SIZE_PX: u32 = 640;
const MARGIN_PX: f64 = 24.0;

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    v.map(|c| c / len)
}

/// Where a view's camera sits: `toward` points from the model to the camera,
/// and `right` and `up` are the screen axes, all unit length and orthogonal.
fn camera(view: View) -> Result<([f64; 3], [f64; 3], [f64; 3]), String> {
    match view {
        View::Isometric => {
            let toward = normalize([1.0, -1.0, 0.8]);
            let up = normalize([-toward[0] * toward[2], -toward[1] * toward[2], 1.0 - toward[2] * toward[2]]);
            Ok((toward, normalize([1.0, 1.0, 0.0]), up))
        }
        // From the front edge of the bed (low y), x to the right and z up.
        View::Front => Ok(([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])),
        // From above, x to the right and y (toward the back of the bed) up.
        View::Top => Ok(([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0])),
        View::Face => Err("preview: a part has no face view".into()),
    }
}

/// PNG of `model` from `view`. The background is transparent.
pub fn render(model: &PrintableModel, view: View) -> Result<Vec<u8>, String> {
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let (view, right, up) = camera(view)?;
    let light = normalize([0.4, -0.7, 1.0]);

    let mut faces = Vec::new();
    for body in model.bodies() {
        let rgb = hex_rgb(&model.palette().colours()[usize::from(body.slot.number()) - 1]);
        let vertices = body.mesh.vertices();
        for t in body.mesh.triangles() {
            let p = t.map(|i| vertices[i as usize].map(|c| c as f64 / 1000.0));
            let u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
            let w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
            let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
            let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if len == 0.0 || dot(n, view) <= 0.0 {
                continue; // degenerate, or facing away
            }
            let shade = 0.35 + 0.65 * dot(n.map(|c| c / len), light).max(0.0);
            let screen = p.map(|q| [dot(q, right), dot(q, up)]);
            let depth = p.iter().map(|q| dot(*q, view)).sum::<f64>() / 3.0;
            faces.push((depth, screen, rgb.map(|c| (f64::from(c) * shade).round().clamp(0.0, 255.0) as u8)));
        }
    }
    if faces.is_empty() {
        return Err("preview: no visible triangles".into());
    }
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for (_, screen, _) in &faces {
        for p in screen {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
    }
    let usable = f64::from(SIZE_PX) - 2.0 * MARGIN_PX;
    let scale = usable / (hi[0] - lo[0]).max(hi[1] - lo[1]).max(1e-6);
    let offset = [(f64::from(SIZE_PX) - (hi[0] - lo[0]) * scale) / 2.0, (f64::from(SIZE_PX) - (hi[1] - lo[1]) * scale) / 2.0];
    let to_px = |p: [f64; 2]| ((offset[0] + (p[0] - lo[0]) * scale) as f32, (f64::from(SIZE_PX) - offset[1] - (p[1] - lo[1]) * scale) as f32);

    faces.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut pixmap = Pixmap::new(SIZE_PX, SIZE_PX).ok_or("preview: cannot allocate the image")?;
    // Without anti-aliasing, neighbouring triangles meet without light seams.
    let mut paint = Paint { anti_alias: false, ..Paint::default() };
    for (_, screen, rgb) in faces {
        let mut path = PathBuilder::new();
        let [a, b, c] = screen.map(to_px);
        path.move_to(a.0, a.1);
        path.line_to(b.0, b.1);
        path.line_to(c.0, c.1);
        path.close();
        let Some(path) = path.finish() else { continue };
        paint.set_color(Color::from_rgba8(rgb[0], rgb[1], rgb[2], 255));
        pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
    pixmap.encode_png().map_err(|e| format!("preview: png encoding failed: {e}"))
}

fn hex_rgb(hex: &str) -> [u8; 3] {
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("80"), 16).unwrap_or(0x80);
    [channel(1), channel(3), channel(5)]
}
