//! The host side of the CAD worker boundary (PR 5 spike; bundled into the app by PR 6's release script).
//!
//! The portable half lives here and is what PR 7's `fabrication/cad_worker.rs` grows from: the bounded guest
//! channel ([`frame`]), the body manifest ([`manifest`]), the mesh decoder plus the 1 um weld and geometry
//! report ([`mesh`]), and the compiled-in runtime pins with the check every boot passes first ([`runtime`]). The
//! macOS VM driver is in the binary.

pub mod frame;
pub mod manifest;
pub mod mesh;
pub mod runtime;
