//! Keeps an update from restarting the app while work runs (issue #79): the
//! sidecar's turns, and each slice Rust runs for it (`crate::sidecar`).
//!
//! Work holds an [`OwnedRunning`] pass for as long as it runs. The updater
//! waits in [`BuildGate::close_when_idle`] until no work runs, and from that
//! moment refuses new work until its [`Closed`] guard drops. The idle check
//! and the close are one step, so no work can start between them.

use tokio::sync::watch;

#[derive(Debug, Default)]
struct Builds {
    running: usize,
    closed: bool,
}

#[derive(Debug, Default)]
pub struct BuildGate(watch::Sender<Builds>);

/// Held by the updater from the idle check until the restart. Dropping it,
/// when the install fails, lets builds start again.
#[must_use]
#[derive(Debug)]
pub struct Closed<'a>(&'a BuildGate);

/// A pass for running work, held through whatever owns its way to the gate,
/// such as the sidecar's `Arc`. Dropping it lets a waiting update go ahead.
#[must_use]
pub struct OwnedRunning<G: std::ops::Deref<Target = BuildGate>>(G);

impl BuildGate {
    /// Lets work start, unless an update is installing. One send_if_modified:
    /// it counts the work unless the gate is closed.
    pub fn enter_owned<G: std::ops::Deref<Target = BuildGate>>(gate: G) -> Option<OwnedRunning<G>> {
        let admitted = gate.0.send_if_modified(|builds| {
            if builds.closed {
                return false;
            }
            builds.running += 1;
            true
        });
        admitted.then(|| OwnedRunning(gate))
    }

    /// Waits until no work runs, then refuses new work until the returned
    /// guard drops. `running` hears how many passes are held at each check,
    /// ending with 0 once the gate closes.
    pub async fn close_when_idle(&self, mut running: impl FnMut(usize)) -> Closed<'_> {
        let mut changes = self.0.subscribe();
        loop {
            changes.borrow_and_update();
            let mut busy = 0;
            let closed = self.0.send_if_modified(|builds| {
                busy = builds.running;
                if busy > 0 || builds.closed {
                    return false;
                }
                builds.closed = true;
                true
            });
            running(busy);
            if closed {
                return Closed(self);
            }
            changes.changed().await.expect("the gate owns the sender for as long as it is borrowed");
        }
    }
}

impl<G: std::ops::Deref<Target = BuildGate>> Drop for OwnedRunning<G> {
    fn drop(&mut self) {
        self.0 .0.send_modify(|builds| builds.running -= 1);
    }
}

impl Drop for Closed<'_> {
    fn drop(&mut self) {
        self.0 .0.send_modify(|builds| builds.closed = false);
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    const SETTLE: Duration = Duration::from_millis(50);

    #[tokio::test]
    async fn an_update_waits_for_every_running_build() {
        let gate = BuildGate::default();
        let first = BuildGate::enter_owned(&gate).expect("first build starts");
        let second = BuildGate::enter_owned(&gate).expect("second build starts");
        let heard = std::cell::RefCell::new(Vec::new());
        let mut close = std::pin::pin!(gate.close_when_idle(|n| heard.borrow_mut().push(n)));

        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "two builds run");
        drop(first);
        assert!(tokio::time::timeout(SETTLE, &mut close).await.is_err(), "one build runs");
        drop(second);
        let _closed = tokio::time::timeout(SETTLE, &mut close).await.expect("no build runs");
        assert_eq!(*heard.borrow(), [2, 1, 0]);
    }

    #[tokio::test]
    async fn no_build_starts_while_an_update_installs_and_builds_start_again_if_it_fails() {
        let gate = BuildGate::default();
        let closed = gate.close_when_idle(|_| {}).await;
        assert!(BuildGate::enter_owned(&gate).is_none(), "a build is refused between the idle check and the restart");
        drop(closed);
        assert!(BuildGate::enter_owned(&gate).is_some(), "a failed install lets builds start again");
    }
}
