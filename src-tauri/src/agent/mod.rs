//! The in-app agent: a Rig agent loop that designs and builds signs through
//! the same [`crate::actions::Actions`] the GUI calls, held only as a
//! [`crate::actions::RequestActions`]. It can build and show signs; approving,
//! exporting, and printing stay with people.

pub mod commands;
pub mod protocol;
pub mod store;
pub mod tools;
pub mod turn;

#[cfg(test)]
mod tests;
