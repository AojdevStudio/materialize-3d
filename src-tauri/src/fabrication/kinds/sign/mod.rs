//! Face-down multicolor signs: the `sign` kind.
//!
//! A spec goes `SignSpec` (serde, untrusted) -> [`ValidSignSpec`] (parsed at
//! the boundary) -> [`SignDesign`], which adds the finished-face
//! [`SignLayout`] derived from it. [`build_model`] turns the layout into the
//! shared [`PrintableModel`](crate::fabrication::model::PrintableModel),
//! [`check_geometry`] measures that model against the layout, and
//! [`render_preview`] draws the layout.
//!
//! Coordinates in a spec are finished-face coordinates: millimeters, origin at
//! the top-left corner, y pointing down, as a person reads the sign. All planar
//! geometry is snapped to a 0.001 mm (1 µm) integer grid so that boolean
//! operations, triangulation checks and mesh edge matching are exact. The
//! face-down transform (`X = W - x`, `Y = H - y`) is applied once, when meshes
//! are emitted, so the finished face lies on the bed and reads normally from
//! below.

mod check;
mod font;
mod geometry;
mod mesh;
mod preview;
mod spec;
mod svg;

#[cfg(test)]
mod tests;

use serde::Serialize;

pub use check::{check_geometry, check_plan, GeometryCheck, SIGN_CHECK_PLAN};
pub use geometry::{build_model, SignLayout};
pub use preview::render_preview;
pub use spec::{Align, Element, FontWeight, Ink, SignSpec, SpecError, ValidSignSpec, SIGN_SCHEMA_VERSION};

use crate::fabrication::checks::{CheckOutcome, CheckPlan, InvalidPlan};
use crate::fabrication::kind::{self, BuildControl, Built, KernelContext, KernelError, KindId, ObjectKind};
use crate::fabrication::model::PrintableModel;
use crate::fabrication::printer::PrinterProfile;

/// Every failure a sign can raise, from its layout to its preview.
#[derive(Debug, thiserror::Error)]
pub enum SignError {
    #[error("invalid sign spec: {0}")]
    Spec(#[from] SpecError),
    #[error("geometry: {0}")]
    Geometry(String),
    #[error("preview: {0}")]
    Preview(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = SignError> = std::result::Result<T, E>;

/// Preview resolution, pixels per millimeter of the finished face.
const PREVIEW_PX_PER_MM: f64 = 4.0;

/// A validated sign and its finished-face layout: what the sign's model,
/// checks, and preview read. It serializes as the validated spec alone, so the
/// layout, which is derived from the spec, never changes the build key.
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct SignDesign {
    spec: ValidSignSpec,
    #[serde(skip)]
    layout: SignLayout,
}

impl SignDesign {
    pub fn new(spec: ValidSignSpec) -> Result<Self> {
        let layout = geometry::layout(&spec)?;
        Ok(Self { spec, layout })
    }

    pub fn spec(&self) -> &ValidSignSpec {
        &self.spec
    }

    pub fn layout(&self) -> &SignLayout {
        &self.layout
    }
}

/// The `sign` kind.
pub struct Sign;

impl ObjectKind for Sign {
    type Spec = SignSpec;
    type Valid = SignDesign;

    const ID: KindId = KindId::new("sign");
    /// The tag sign builds carried before kinds existed, so their build keys
    /// are unchanged and their verified builds are reused.
    const TAG: &'static str = "sign-pipeline-1";
    const SUMMARY: &'static str = "a face-down multicolor sign: a base color with one or two flush inlay colors";

    fn validate(spec: SignSpec, printer: &PrinterProfile) -> std::result::Result<SignDesign, kind::SpecError> {
        let spec = ValidSignSpec::parse(spec, printer).map_err(|e| kind::SpecError(e.to_string()))?;
        SignDesign::new(spec).map_err(|e| kind::SpecError(e.to_string()))
    }

    fn title(valid: &SignDesign) -> String {
        valid.spec.title().to_owned()
    }

    fn check_plan(valid: &SignDesign, _printer: &PrinterProfile) -> std::result::Result<CheckPlan, InvalidPlan> {
        check_plan(&valid.spec)
    }

    fn model(valid: &SignDesign, ctx: &KernelContext, _control: &BuildControl<'_>) -> std::result::Result<Built, KernelError> {
        let model = build_model(&valid.layout, valid.spec.title(), &ctx.printer).map_err(kernel)?;
        Ok(Built { model, extra: Vec::new() })
    }

    fn measure(
        valid: &SignDesign,
        model: &PrintableModel,
        _control: &BuildControl<'_>,
    ) -> std::result::Result<Vec<CheckOutcome>, KernelError> {
        Ok(check_geometry(&valid.layout, model).iter().map(GeometryCheck::outcome).collect())
    }

    fn preview(valid: &SignDesign, _model: &PrintableModel) -> std::result::Result<Vec<u8>, KernelError> {
        render_preview(&valid.layout, PREVIEW_PX_PER_MM).map_err(kernel)
    }
}

fn kernel(err: SignError) -> KernelError {
    KernelError::Failed(err.to_string())
}
