//! Keeps an update from restarting the app while a build runs (issue #79).
//!
//! Every build holds a [`Running`] pass for as long as it runs. The updater
//! waits in [`BuildGate::close_when_idle`] until no build runs, and from that
//! moment refuses new builds until its [`Closed`] guard drops. The idle check
//! and the close are one step, so no build can start between them.

use tokio::sync::watch;

#[derive(Debug, Default)]
struct Builds {
    running: usize,
    closed: bool,
}

#[derive(Debug, Default)]
pub struct BuildGate(watch::Sender<Builds>);

/// Held by a running build. Dropping it lets a waiting update go ahead.
#[must_use]
pub struct Running<'a>(&'a BuildGate);

/// Held by the updater from the idle check until the restart. Dropping it,
/// when the install fails, lets builds start again.
#[must_use]
#[derive(Debug)]
pub struct Closed<'a>(&'a BuildGate);

impl BuildGate {
    /// Lets a build start, unless an update is installing.
    pub fn enter(&self) -> Option<Running<'_>> {
        self.0
            .send_if_modified(|builds| {
                if builds.closed {
                    return false;
                }
                builds.running += 1;
                true
            })
            .then(|| Running(self))
    }

    /// Waits until no build runs, then refuses new builds until the returned
    /// guard drops. `running` hears how many builds are running at each check,
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

impl Drop for Running<'_> {
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
        let first = gate.enter().expect("first build starts");
        let second = gate.enter().expect("second build starts");
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
        assert!(gate.enter().is_none(), "a build is refused between the idle check and the restart");
        drop(closed);
        assert!(gate.enter().is_some(), "a failed install lets builds start again");
    }
}
