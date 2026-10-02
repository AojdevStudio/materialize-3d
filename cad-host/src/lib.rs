//! PR 5 spike: the host side of the CAD worker boundary.
//!
//! The portable half lives here and is what PR 7's `fabrication/cad_worker.rs` grows from: the bounded guest
//! channel ([`frame`]), the body manifest ([`manifest`]), and the mesh decoder plus the 1 um weld and geometry
//! report ([`mesh`]). The macOS VM driver is in the binary.

pub mod frame;
pub mod manifest;
pub mod mesh;
