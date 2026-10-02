//! Face-down multicolor sign geometry.
//!
//! The pipeline is `SignSpec` (serde, untrusted) -> [`ValidSignSpec`] (parsed at
//! the boundary) -> [`build_geometry`] -> [`check_geometry`] /
//! [`render_preview`]. [`build_geometry`] ends by converting the sign into the
//! shared [`PrintableModel`](crate::fabrication::model::PrintableModel), which
//! [`check_plan`] certifies before the shared package writer takes it.
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

pub use check::{check_geometry, check_plan, GeometryCheck, SIGN_CHECK_PLAN};
pub use geometry::{build_geometry, SignGeometry};
pub use preview::render_preview;
pub use spec::{
    spec_hash, Align, Element, FontWeight, Ink, SignSpec, SpecError, ValidSignSpec,
    SIGN_SCHEMA_VERSION,
};

/// Every failure `build_sign` can surface, from spec validation to packaging.
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
