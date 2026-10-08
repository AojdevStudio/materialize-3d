//! The part spec: the untrusted wire shape and its validated form.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fabrication::checks::{CheckId, CheckPhase};
use crate::fabrication::kind::SpecError;
use crate::fabrication::model::Palette;
use crate::fabrication::printer::{PrinterProfile, Um, UM_PER_MM};

/// Schema version this build accepts in [`PartSpec::schema_version`].
pub const PART_SCHEMA_VERSION: u32 = 1;
const MAX_TITLE_CHARS: usize = 80;
/// The script, in UTF-8 bytes.
const MAX_SOURCE_BYTES: usize = 64 << 10;
const MAX_PARAMS: usize = 64;
const MAX_PARAM_NAME_CHARS: usize = 64;
const MAX_TEXT_PARAM_CHARS: usize = 200;
const MAX_REQUIREMENTS: usize = 32;
const MAX_NAME_CHARS: usize = 80;
/// Largest length or coordinate a requirement may state, mm.
const MAX_MM: f64 = 2_000.0;
/// The colour a filament without one is written in: the neutral gray the
/// package already uses for a printer slot the model leaves empty.
const NO_COLOUR: &str = "#808080";

/// A part as a caller writes it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PartSpec {
    #[schemars(extend("const" = PART_SCHEMA_VERSION))]
    pub schema_version: u32,
    /// Shown in revision lists and kept in the 3MF's Title metadata.
    pub title: String,
    /// build123d source defining `build(params) -> list[Body]`, in
    /// millimeters with z = 0 the bed. At most 64 KiB.
    pub source: String,
    /// Scalars only: what a person might change without touching the code.
    pub params: BTreeMap<String, ParamValue>,
    /// The person's measurements, checked on the built mesh.
    pub requirements: Vec<Requirement>,
    /// One per filament slot, slot 1 first.
    pub filaments: Vec<Filament>,
}

/// A param: a number, an integer, a bool, or a short string.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(untagged)]
pub enum ParamValue {
    Bool(bool),
    Integer(i64),
    Number(f64),
    Text(String),
}

/// A measurement the person gave, checked on the returned mesh. `at` is a
/// point in millimeters inside the feature (inside the gap, inside the hole,
/// inside the wall), so the measurement is unambiguous.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "measure", rename_all = "snake_case", deny_unknown_fields)]
pub enum Requirement {
    /// Overall extent of the part along an axis.
    Span { name: String, axis: Axis, mm: f64, tol: f64 },
    /// Width of the empty gap along `axis`, measured through `at`.
    Opening { name: String, axis: Axis, at: [f64; 3], mm: f64, tol: f64 },
    /// Diameter of the hole whose centerline runs along `axis` through `at`.
    Hole { name: String, axis: Axis, at: [f64; 3], mm: f64, tol: f64 },
    /// Material thickness at `at` is at least `mm`.
    MinWall { name: String, at: [f64; 3], mm: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    X,
    Y,
    Z,
}

impl Axis {
    pub fn index(self) -> usize {
        match self {
            Axis::X => 0,
            Axis::Y => 1,
            Axis::Z => 2,
        }
    }
}

/// One filament slot.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Filament {
    /// 1 for the first slot; the slots count up from 1 in order.
    pub slot: u8,
    pub name: String,
    /// `#RRGGBB`; without it the slot is written in neutral gray.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hex: Option<String>,
}

/// A requirement ready to measure: lengths in µm, and its check id.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MeasuredRequirement {
    /// Position in the spec; the check is `geometry.requirement.<index>`.
    pub index: usize,
    /// Display text only.
    pub name: String,
    pub measure: Measure,
}

/// What to measure, in µm.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "measure", rename_all = "snake_case")]
pub enum Measure {
    Span { axis: Axis, um: Um, tol_um: Um },
    Opening { axis: Axis, at_um: [Um; 3], um: Um, tol_um: Um },
    Hole { axis: Axis, at_um: [Um; 3], um: Um, tol_um: Um },
    MinWall { at_um: [Um; 3], um: Um },
}

impl MeasuredRequirement {
    pub fn check_id(&self) -> CheckId {
        CheckId::new(CheckPhase::Geometry, &format!("{REQUIREMENT}.{}", self.index))
    }
}

/// The name every requirement check shares before its index.
const REQUIREMENT: &str = "requirement";

/// True for a requirement's check id (`geometry.requirement.<index>`): what a
/// summary lists as the person's measurements.
pub fn is_requirement_check(id: &CheckId) -> bool {
    id.phase() == CheckPhase::Geometry
        && id.as_str().strip_prefix("geometry.").and_then(|name| name.strip_prefix(REQUIREMENT)).is_some_and(|rest| {
            rest.strip_prefix('.').is_some_and(|index| !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit()))
        })
}

/// A part spec that passed validation: the source within its size, params
/// bounded, requirements typed, and filaments that fit the printer. Says
/// nothing about whether the script is safe to run; only the worker runs it.
/// Its JSON is what the build key hashes.
#[derive(Debug, Clone, Serialize)]
pub struct ValidPart {
    schema_version: u32,
    title: String,
    source: String,
    params: BTreeMap<String, ParamValue>,
    requirements: Vec<MeasuredRequirement>,
    filaments: Vec<Filament>,
    #[serde(skip)]
    palette: Palette,
    /// The printer's build volume, which every body must fit.
    #[serde(skip)]
    bed: [Um; 3],
}

impl ValidPart {
    pub fn parse(spec: PartSpec, printer: &PrinterProfile) -> Result<Self, SpecError> {
        let err = |text: String| Err(SpecError(text));
        if spec.schema_version != PART_SCHEMA_VERSION {
            return err(format!("schema_version {} is not supported (expected {PART_SCHEMA_VERSION})", spec.schema_version));
        }
        let title = spec.title.trim();
        if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
            return err(format!("title must be 1 to {MAX_TITLE_CHARS} characters with no control characters"));
        }
        if spec.source.trim().is_empty() || spec.source.len() > MAX_SOURCE_BYTES {
            return err(format!("source must be 1 to {MAX_SOURCE_BYTES} bytes of build123d, {} given", spec.source.len()));
        }
        if spec.source.contains('\0') {
            return err("source must not contain NUL characters".into());
        }
        validate_params(&spec.params)?;
        if spec.requirements.len() > MAX_REQUIREMENTS {
            return err(format!("requirements: at most {MAX_REQUIREMENTS}, {} given", spec.requirements.len()));
        }
        let requirements = spec.requirements.iter().enumerate().map(|(i, r)| measured(i, r)).collect::<Result<Vec<_>, _>>()?;
        let (filaments, palette) = filaments(spec.filaments, printer)?;
        Ok(Self {
            schema_version: spec.schema_version,
            title: title.to_owned(),
            source: spec.source,
            params: spec.params,
            requirements,
            filaments,
            palette,
            bed: printer.bed,
        })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    /// The params as the script reads them: `build(params)` gets this object.
    pub fn params_json(&self) -> Value {
        serde_json::to_value(&self.params).expect("params are plain JSON scalars")
    }

    pub fn requirements(&self) -> &[MeasuredRequirement] {
        &self.requirements
    }

    pub fn palette(&self) -> &Palette {
        &self.palette
    }

    pub fn bed(&self) -> [Um; 3] {
        self.bed
    }
}

fn validate_params(params: &BTreeMap<String, ParamValue>) -> Result<(), SpecError> {
    if params.len() > MAX_PARAMS {
        return Err(SpecError(format!("params: at most {MAX_PARAMS}, {} given", params.len())));
    }
    for (name, value) in params {
        let identifier = name.chars().count() <= MAX_PARAM_NAME_CHARS
            && name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !identifier {
            return Err(SpecError(format!("params: {name:?} must be a name of letters, digits, and _ (at most {MAX_PARAM_NAME_CHARS})")));
        }
        match value {
            ParamValue::Number(n) if !n.is_finite() => return Err(SpecError(format!("params.{name}: {n} is not a finite number"))),
            ParamValue::Text(text) if text.chars().count() > MAX_TEXT_PARAM_CHARS || text.chars().any(char::is_control) => {
                return Err(SpecError(format!("params.{name}: text must be at most {MAX_TEXT_PARAM_CHARS} characters with no control characters")));
            }
            _ => {}
        }
    }
    Ok(())
}

fn measured(index: usize, requirement: &Requirement) -> Result<MeasuredRequirement, SpecError> {
    let field = |what: &str| format!("requirements[{index}].{what}");
    let name = match requirement {
        Requirement::Span { name, .. } | Requirement::Opening { name, .. } | Requirement::Hole { name, .. } | Requirement::MinWall { name, .. } => name.trim(),
    };
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(SpecError(format!("{} must be 1 to {MAX_NAME_CHARS} characters with no control characters", field("name"))));
    }
    let length = |mm: f64, what: &str| -> Result<Um, SpecError> {
        if mm.is_finite() && mm > 0.0 && mm <= MAX_MM {
            Ok(um(mm))
        } else {
            Err(SpecError(format!("{} must be more than 0 and at most {MAX_MM} mm, got {mm}", field(what))))
        }
    };
    let tolerance = |tol: f64, of: f64| -> Result<Um, SpecError> {
        if tol.is_finite() && tol >= 0.0 && tol <= of {
            Ok(um(tol))
        } else {
            Err(SpecError(format!("{} must be from 0 to the measurement itself, got {tol}", field("tol"))))
        }
    };
    let point = |at: &[f64; 3]| -> Result<[Um; 3], SpecError> {
        if at.iter().all(|c| c.is_finite() && c.abs() <= MAX_MM) {
            Ok(at.map(um))
        } else {
            Err(SpecError(format!("{} must be three finite coordinates within {MAX_MM} mm", field("at"))))
        }
    };
    let measure = match requirement {
        Requirement::Span { axis, mm, tol, .. } => Measure::Span { axis: *axis, um: length(*mm, "mm")?, tol_um: tolerance(*tol, *mm)? },
        Requirement::Opening { axis, at, mm, tol, .. } => {
            Measure::Opening { axis: *axis, at_um: point(at)?, um: length(*mm, "mm")?, tol_um: tolerance(*tol, *mm)? }
        }
        Requirement::Hole { axis, at, mm, tol, .. } => {
            Measure::Hole { axis: *axis, at_um: point(at)?, um: length(*mm, "mm")?, tol_um: tolerance(*tol, *mm)? }
        }
        Requirement::MinWall { at, mm, .. } => Measure::MinWall { at_um: point(at)?, um: length(*mm, "mm")? },
    };
    Ok(MeasuredRequirement { index, name: name.to_owned(), measure })
}

fn um(mm: f64) -> Um {
    (mm * UM_PER_MM as f64).round() as Um
}

fn filaments(given: Vec<Filament>, printer: &PrinterProfile) -> Result<(Vec<Filament>, Palette), SpecError> {
    if given.is_empty() || given.len() > usize::from(printer.slots) {
        return Err(SpecError(format!("filaments: 1 to {} slots, {} given", printer.slots, given.len())));
    }
    let mut names = BTreeSet::new();
    let mut filaments = Vec::with_capacity(given.len());
    for (i, filament) in given.into_iter().enumerate() {
        let want = u8::try_from(i + 1).expect("at most a printer's slots");
        if filament.slot != want {
            return Err(SpecError(format!("filaments[{i}].slot must be {want}: slots count up from 1 in order")));
        }
        let name = filament.name.trim().to_owned();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) || !names.insert(name.clone()) {
            return Err(SpecError(format!("filaments[{i}].name must be 1 to {MAX_NAME_CHARS} characters, used once")));
        }
        let hex = match filament.hex {
            Some(hex) => {
                let upper = hex.to_ascii_uppercase();
                let valid = upper.len() == 7 && upper.starts_with('#') && upper[1..].bytes().all(|b| b.is_ascii_hexdigit());
                if !valid {
                    return Err(SpecError(format!("filaments[{i}].hex {hex:?} is not #RRGGBB")));
                }
                Some(upper)
            }
            None => None,
        };
        filaments.push(Filament { slot: want, name, hex });
    }
    let colours = filaments.iter().map(|f| f.hex.clone().unwrap_or_else(|| NO_COLOUR.to_owned())).collect();
    let palette = Palette::new(colours, printer).map_err(|e| SpecError(format!("filaments: {e}")))?;
    Ok((filaments, palette))
}
