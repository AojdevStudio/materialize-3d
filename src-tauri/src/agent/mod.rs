//! The in-app agent: a Rig agent loop that designs and builds signs through
//! the same [`crate::actions::Actions`] functions the GUI calls. It can build
//! and show signs; approving, exporting, and printing stay with people.

pub mod commands;
pub mod protocol;
pub mod store;
pub mod tools;
pub mod turn;

#[cfg(test)]
mod tests;
