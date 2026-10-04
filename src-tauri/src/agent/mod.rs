//! The in-app agent: a Rig agent loop that designs and builds objects of every
//! kind the app can build, through the same [`crate::actions::Actions`] the GUI
//! calls, held only as a [`crate::actions::RequestActions`]. It can describe,
//! build, revise, and show designs; approving, exporting, and printing stay
//! with people.

pub mod commands;
pub mod prompt;
pub mod protocol;
pub mod store;
pub mod tools;
pub mod turn;

#[cfg(test)]
pub(crate) mod tests;
