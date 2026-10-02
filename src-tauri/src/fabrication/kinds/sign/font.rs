//! Vendored Lato faces (SIL OFL, see resources/fonts/OFL.txt) and text outlines.

use ttf_parser::{Face, OutlineBuilder};

use super::geometry::ContourBuilder;
use super::spec::{Align, Contour, FontWeight};

static LATO_BLACK: &[u8] = include_bytes!("../../../../resources/fonts/Lato-Black.ttf");
static LATO_BOLD: &[u8] = include_bytes!("../../../../resources/fonts/Lato-Bold.ttf");
static LATO_REGULAR: &[u8] = include_bytes!("../../../../resources/fonts/Lato-Regular.ttf");

fn face(weight: FontWeight) -> Face<'static> {
    let data = match weight {
        FontWeight::Heavy => LATO_BLACK,
        FontWeight::Bold => LATO_BOLD,
        FontWeight::Regular => LATO_REGULAR,
    };
    Face::parse(data, 0).expect("vendored Lato font parses")
}

/// First character of `text` the face cannot draw, if any.
pub(crate) fn first_missing_glyph(weight: FontWeight, text: &str) -> Option<char> {
    let face = face(weight);
    text.chars().find(|&c| face.glyph_index(c).is_none())
}

/// Advance width of `text` in millimeters at the given cap height.
pub(crate) fn text_width_mm(weight: FontWeight, text: &str, cap_height_mm: f64) -> f64 {
    let face = face(weight);
    let scale = scale(&face, cap_height_mm);
    text.chars()
        .filter_map(|c| face.glyph_index(c))
        .map(|g| f64::from(face.glyph_hor_advance(g).unwrap_or(0)) * scale)
        .sum()
}

fn scale(face: &Face<'_>, cap_height_mm: f64) -> f64 {
    let cap_units = face
        .capital_height()
        .filter(|h| *h > 0)
        .expect("vendored Lato font has a cap height");
    cap_height_mm / f64::from(cap_units)
}

/// Glyph outlines of one line of text, flattened into finished-face
/// millimeters (y down). `(x_mm, y_mm)` is the anchor on the baseline; `align`
/// says whether it is the left end, center or right end of the advance width.
/// No kerning is applied. Contours use the nonzero fill rule.
pub(crate) fn text_contours(
    weight: FontWeight,
    text: &str,
    cap_height_mm: f64,
    [x_mm, y_mm]: [f64; 2],
    align: Align,
) -> Vec<Contour> {
    let face = face(weight);
    let scale = scale(&face, cap_height_mm);
    let width = text_width_mm(weight, text, cap_height_mm);
    let mut pen = match align {
        Align::Left => x_mm,
        Align::Center => x_mm - width / 2.0,
        Align::Right => x_mm - width,
    };
    let mut builder = ContourBuilder::default();
    for glyph in text.chars().filter_map(|c| face.glyph_index(c)) {
        let mut sink = GlyphSink {
            builder: &mut builder,
            origin: [pen, y_mm],
            scale,
        };
        face.outline_glyph(glyph, &mut sink);
        builder.close();
        pen += f64::from(face.glyph_hor_advance(glyph).unwrap_or(0)) * scale;
    }
    builder.finish()
}

/// Maps font units (y up) onto the finished face (mm, y down).
struct GlyphSink<'a> {
    builder: &'a mut ContourBuilder,
    origin: [f64; 2],
    scale: f64,
}

impl GlyphSink<'_> {
    fn map(&self, x: f32, y: f32) -> [f64; 2] {
        [
            self.origin[0] + f64::from(x) * self.scale,
            self.origin[1] - f64::from(y) * self.scale,
        ]
    }
}

impl OutlineBuilder for GlyphSink<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let p = self.map(x, y);
        self.builder.move_to(p);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let p = self.map(x, y);
        self.builder.line_to(p);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (c, p) = (self.map(x1, y1), self.map(x, y));
        self.builder.quad_to(c, p);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (c1, c2, p) = (self.map(x1, y1), self.map(x2, y2), self.map(x, y));
        self.builder.cubic_to(c1, c2, p);
    }

    fn close(&mut self) {
        self.builder.close();
    }
}
