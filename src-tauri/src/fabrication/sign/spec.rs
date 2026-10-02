//! Sign spec: the untrusted serde shape and its validated form.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{font, svg};
use crate::fabrication::printer::{P2S_04, UM_PER_MM};

const MAX_TITLE_CHARS: usize = 80;
/// Schema version this build accepts in `SignSpec::schema_version`.
pub const SIGN_SCHEMA_VERSION: u32 = 1;

/// Largest sign edge that fits the bed of the printer the package targets.
const MAX_EDGE_MM: f64 = (P2S_04.max_edge() / UM_PER_MM) as f64;

fn default_thickness() -> f64 {
    2.6
}

fn default_inlay_depth() -> f64 {
    0.4
}

/// A sign as requested by a caller (agent tool or UI). Parse it with
/// [`ValidSignSpec::parse`] or [`ValidSignSpec::from_json`] before use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SignSpec {
    pub schema_version: u32,
    /// Shown in revision lists and embedded as the 3MF object name.
    #[serde(default)]
    pub title: Option<String>,
    pub width_mm: f64,
    pub height_mm: f64,
    #[serde(default = "default_thickness")]
    pub thickness_mm: f64,
    #[serde(default = "default_inlay_depth")]
    pub inlay_depth_mm: f64,
    #[serde(default)]
    pub corner_radius_mm: Option<f64>,
    /// Filament slot 1: the body color and the knockout color.
    pub base: Ink,
    /// Filament slots 2 and 3, printed as flush inlays on the finished face.
    pub inks: Vec<Ink>,
    /// Painted in order; later elements paint over earlier ones.
    pub elements: Vec<Element>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Ink {
    pub name: String,
    /// `#RRGGBB`
    pub hex: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FontWeight {
    Heavy,
    Bold,
    Regular,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Align {
    Left,
    Center,
    Right,
}

/// One painted element. `ink` names the base (a knockout) or one of the inks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Element {
    Text {
        ink: String,
        text: String,
        font: FontWeight,
        cap_height_mm: f64,
        x_mm: f64,
        /// Baseline.
        y_mm: f64,
        align: Align,
    },
    Rect {
        ink: String,
        x_mm: f64,
        y_mm: f64,
        w_mm: f64,
        h_mm: f64,
        #[serde(default)]
        corner_radius_mm: Option<f64>,
    },
    Svg {
        /// Normalized `#rrggbb` fill color -> ink name.
        ink_map: BTreeMap<String, String>,
        /// Inline SVG document.
        svg_source: String,
        /// Top-left corner of the SVG viewport on the finished face.
        x_mm: f64,
        y_mm: f64,
        /// Viewport width; height follows the SVG aspect ratio.
        w_mm: f64,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum SpecError {
    #[error("title must be at most 80 characters with no control characters: {0:?}")]
    Title(String),
    #[error("malformed spec: {0}")]
    Json(#[from] serde_json::Error),
    #[error("schema_version {found} is not supported (expected {SIGN_SCHEMA_VERSION})")]
    SchemaVersion { found: u32 },
    #[error("{field}: {reason}")]
    Dimension { field: String, reason: String },
    #[error("inks: expected 1 or 2 inks, got {0}")]
    InkCount(usize),
    #[error("ink {name:?}: hex {hex:?} is not #RRGGBB")]
    BadHex { name: String, hex: String },
    #[error("ink name {0:?} is empty or used twice")]
    InkName(String),
    #[error("element {element}: unknown ink {ink:?}")]
    UnknownInk { element: usize, ink: String },
    #[error("element {element}: {reason}")]
    Text { element: usize, reason: String },
    #[error("element {element}: font has no glyph for {ch:?}")]
    MissingGlyph { element: usize, ch: char },
    #[error("element {element}: svg fill {color} has no entry in ink_map")]
    UnmappedSvgColor { element: usize, color: String },
    #[error("element {element}: svg strokes are not supported; convert them to filled paths")]
    SvgStroke { element: usize },
    #[error("element {element}: {reason}")]
    Svg { element: usize, reason: String },
}

/// Palette position: 0 is the base (filament slot 1), 1 and 2 are the inks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct InkIndex(pub(crate) usize);

impl InkIndex {
    pub fn is_base(self) -> bool {
        self.0 == 0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct ValidInk {
    pub name: String,
    /// Uppercase `#RRGGBB`.
    pub hex: String,
    #[serde(skip)]
    pub rgb: [u8; 3],
}

/// Polygon fill rule of a painted outline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) enum FillRule {
    NonZero,
    EvenOdd,
}

/// Closed polygon in finished-face millimeters (y down).
pub(crate) type Contour = Vec<[f64; 2]>;

/// One filled SVG path, flattened into finished-face millimeters.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SvgFill {
    pub ink: InkIndex,
    pub rule: FillRule,
    pub contours: Vec<Contour>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ValidElement {
    Text {
        ink: InkIndex,
        text: String,
        font: FontWeight,
        cap_height_mm: f64,
        x_mm: f64,
        y_mm: f64,
        align: Align,
    },
    Rect {
        ink: InkIndex,
        x_mm: f64,
        y_mm: f64,
        w_mm: f64,
        h_mm: f64,
        corner_radius_mm: Option<f64>,
    },
    Svg {
        ink_map: BTreeMap<String, InkIndex>,
        svg_source: String,
        x_mm: f64,
        y_mm: f64,
        w_mm: f64,
        /// Derived from `svg_source` during validation; not part of the hash.
        #[serde(skip)]
        fills: Vec<SvgFill>,
    },
}

/// A sign spec that passed validation. Only [`ValidSignSpec::parse`] builds one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValidSignSpec {
    pub(crate) schema_version: u32,
    pub(crate) title: String,
    pub(crate) width_mm: f64,
    pub(crate) height_mm: f64,
    pub(crate) thickness_mm: f64,
    pub(crate) inlay_depth_mm: f64,
    pub(crate) corner_radius_mm: Option<f64>,
    /// Index 0 is the base; 1.. are the inks.
    pub(crate) palette: Vec<ValidInk>,
    pub(crate) elements: Vec<ValidElement>,
}

impl ValidSignSpec {
    pub fn from_json(json: &str) -> Result<Self, SpecError> {
        Self::parse(serde_json::from_str(json)?)
    }

    pub fn parse(spec: SignSpec) -> Result<Self, SpecError> {
        if spec.schema_version != SIGN_SCHEMA_VERSION {
            return Err(SpecError::SchemaVersion {
                found: spec.schema_version,
            });
        }
        positive("width_mm", spec.width_mm)?;
        positive("height_mm", spec.height_mm)?;
        positive("thickness_mm", spec.thickness_mm)?;
        positive("inlay_depth_mm", spec.inlay_depth_mm)?;
        for (field, value) in [("width_mm", spec.width_mm), ("height_mm", spec.height_mm)] {
            if value > MAX_EDGE_MM {
                return Err(dimension(
                    field,
                    format!("{value} mm exceeds the {MAX_EDGE_MM} mm bed"),
                ));
            }
        }
        if spec.inlay_depth_mm >= spec.thickness_mm {
            return Err(dimension(
                "inlay_depth_mm",
                "must be less than thickness_mm",
            ));
        }
        if let Some(r) = spec.corner_radius_mm {
            non_negative("corner_radius_mm", r)?;
            if r * 2.0 > spec.width_mm.min(spec.height_mm) {
                return Err(dimension(
                    "corner_radius_mm",
                    "exceeds half the shorter edge",
                ));
            }
        }

        let title = spec.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or("Untitled sign").to_owned();
        if title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
            return Err(SpecError::Title(title));
        }

        if !(1..=2).contains(&spec.inks.len()) {
            return Err(SpecError::InkCount(spec.inks.len()));
        }
        let palette = std::iter::once(&spec.base)
            .chain(&spec.inks)
            .map(valid_ink)
            .collect::<Result<Vec<_>, _>>()?;
        let mut names = BTreeSet::new();
        for ink in &palette {
            if ink.name.trim().is_empty() || !names.insert(ink.name.as_str()) {
                return Err(SpecError::InkName(ink.name.clone()));
            }
        }
        let lookup = |element: usize, name: &str| {
            palette
                .iter()
                .position(|ink| ink.name == name)
                .map(InkIndex)
                .ok_or_else(|| SpecError::UnknownInk {
                    element,
                    ink: name.to_owned(),
                })
        };

        let elements = spec
            .elements
            .into_iter()
            .enumerate()
            .map(|(i, element)| valid_element(i, element, &lookup))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            schema_version: spec.schema_version,
            title,
            width_mm: spec.width_mm,
            height_mm: spec.height_mm,
            thickness_mm: spec.thickness_mm,
            inlay_depth_mm: spec.inlay_depth_mm,
            corner_radius_mm: spec.corner_radius_mm.filter(|r| *r > 0.0),
            palette,
            elements,
        })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn width_mm(&self) -> f64 {
        self.width_mm
    }

    pub fn height_mm(&self) -> f64 {
        self.height_mm
    }

    pub fn thickness_mm(&self) -> f64 {
        self.thickness_mm
    }

    pub fn inlay_depth_mm(&self) -> f64 {
        self.inlay_depth_mm
    }
}

fn valid_element(
    i: usize,
    element: Element,
    lookup: &impl Fn(usize, &str) -> Result<InkIndex, SpecError>,
) -> Result<ValidElement, SpecError> {
    Ok(match element {
        Element::Text {
            ink,
            text,
            font,
            cap_height_mm,
            x_mm,
            y_mm,
            align,
        } => {
            positive(&format!("elements[{i}].cap_height_mm"), cap_height_mm)?;
            finite(&format!("elements[{i}].x_mm"), x_mm)?;
            finite(&format!("elements[{i}].y_mm"), y_mm)?;
            if text.trim().is_empty() {
                return Err(SpecError::Text {
                    element: i,
                    reason: "text is empty".into(),
                });
            }
            if let Some(ch) = text.chars().find(|c| c.is_control()) {
                return Err(SpecError::Text {
                    element: i,
                    reason: format!("control character {ch:?}; use one text element per line"),
                });
            }
            if let Some(ch) = font::first_missing_glyph(font, &text) {
                return Err(SpecError::MissingGlyph { element: i, ch });
            }
            ValidElement::Text {
                ink: lookup(i, &ink)?,
                text,
                font,
                cap_height_mm,
                x_mm,
                y_mm,
                align,
            }
        }
        Element::Rect {
            ink,
            x_mm,
            y_mm,
            w_mm,
            h_mm,
            corner_radius_mm,
        } => {
            finite(&format!("elements[{i}].x_mm"), x_mm)?;
            finite(&format!("elements[{i}].y_mm"), y_mm)?;
            positive(&format!("elements[{i}].w_mm"), w_mm)?;
            positive(&format!("elements[{i}].h_mm"), h_mm)?;
            if let Some(r) = corner_radius_mm {
                let field = format!("elements[{i}].corner_radius_mm");
                non_negative(&field, r)?;
                if r * 2.0 > w_mm.min(h_mm) {
                    return Err(dimension(&field, "exceeds half the shorter edge"));
                }
            }
            ValidElement::Rect {
                ink: lookup(i, &ink)?,
                x_mm,
                y_mm,
                w_mm,
                h_mm,
                corner_radius_mm: corner_radius_mm.filter(|r| *r > 0.0),
            }
        }
        Element::Svg {
            ink_map,
            svg_source,
            x_mm,
            y_mm,
            w_mm,
        } => {
            finite(&format!("elements[{i}].x_mm"), x_mm)?;
            finite(&format!("elements[{i}].y_mm"), y_mm)?;
            positive(&format!("elements[{i}].w_mm"), w_mm)?;
            let mut map = BTreeMap::new();
            for (color, ink) in ink_map {
                let normalized = parse_hex(&color)
                    .map(|rgb| format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]))
                    .ok_or_else(|| SpecError::Svg {
                        element: i,
                        reason: format!("ink_map key {color:?} is not #rrggbb"),
                    })?;
                if map.insert(normalized, lookup(i, &ink)?).is_some() {
                    return Err(SpecError::Svg {
                        element: i,
                        reason: format!("ink_map key {color:?} is listed twice"),
                    });
                }
            }
            let fills = svg::flatten(i, &svg_source, &map, [x_mm, y_mm], w_mm)?;
            ValidElement::Svg {
                ink_map: map,
                svg_source,
                x_mm,
                y_mm,
                w_mm,
                fills,
            }
        }
    })
}

fn valid_ink(ink: &Ink) -> Result<ValidInk, SpecError> {
    let rgb = parse_hex(&ink.hex).ok_or_else(|| SpecError::BadHex {
        name: ink.name.clone(),
        hex: ink.hex.clone(),
    })?;
    Ok(ValidInk {
        name: ink.name.clone(),
        hex: format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]),
        rgb,
    })
}

/// Parses `#RRGGBB` (either case).
pub(crate) fn parse_hex(hex: &str) -> Option<[u8; 3]> {
    let digits = hex.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

fn dimension(field: &str, reason: impl Into<String>) -> SpecError {
    SpecError::Dimension {
        field: field.to_owned(),
        reason: reason.into(),
    }
}

fn finite(field: &str, value: f64) -> Result<(), SpecError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(dimension(field, "must be a finite number"))
    }
}

fn positive(field: &str, value: f64) -> Result<(), SpecError> {
    if value.is_finite() && value > 0.0 {
        Ok(())
    } else {
        Err(dimension(field, "must be a positive number"))
    }
}

fn non_negative(field: &str, value: f64) -> Result<(), SpecError> {
    if value.is_finite() && value >= 0.0 {
        Ok(())
    } else {
        Err(dimension(field, "must be zero or positive"))
    }
}

/// SHA-256 (lowercase hex) of the spec's canonical JSON: object keys sorted,
/// no whitespace, derived data excluded. Input field order does not matter.
pub fn spec_hash(spec: &ValidSignSpec) -> String {
    let value = serde_json::to_value(spec).expect("ValidSignSpec always serializes");
    let mut canonical = String::new();
    write_canonical(&value, &mut canonical);
    hex_digest(canonical.as_bytes())
}

pub(crate) fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn write_canonical(value: &serde_json::Value, out: &mut String) {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            out.push('{');
            for (i, (key, value)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(value, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}
