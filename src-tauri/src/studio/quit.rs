//! A normal quit, or closing the window, waits briefly for the window to save what the person typed but has not
//! saved yet. The window saves its draft a moment after typing pauses, so text typed just before a quit would be lost
//! without this. A restart for an update cannot be held: Tauri ignores a hold on it, and the update waits for idle.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::Notify;

/// The event that asks the window to save its draft now.
const FLUSH: &str = "studio://flush";

/// How long a quit waits for the window. A window that does not answer, as one that is gone, never holds it longer.
const FLUSH_WAIT: Duration = Duration::from_millis(1500);

/// What runs once the window has saved: the quit, or the window's close, each held for the save.
type Held = Box<dyn FnOnce() + Send>;

/// Where the save before a quit stands.
#[derive(Default)]
enum Stage {
    #[default]
    Idle,
    /// The window was asked. Each quit or close that came meanwhile waits here for the same save.
    Saving(Vec<Held>),
    /// The window saved, or the wait ended. A quit or close now goes through.
    Saved,
}

#[derive(Default)]
pub struct QuitFlush {
    stage: Mutex<Stage>,
    saved: Notify,
}

impl QuitFlush {
    /// Holds a quit or a close until the window has saved its draft, and then runs `then`. The first one asks the
    /// window. One that comes while it saves waits for the same save. Returns whether it held, so the caller stops the
    /// quit or close for now; once the window has saved, nothing is held.
    pub fn hold<R: Runtime>(app: &AppHandle<R>, then: impl FnOnce(AppHandle<R>) + Send + 'static) -> bool {
        let flush = app.state::<QuitFlush>();
        let mut stage = flush.stage.lock().unwrap_or_else(|e| e.into_inner());
        let handle = app.clone();
        let held: Held = Box::new(move || then(handle));
        match &mut *stage {
            Stage::Saved => return false,
            Stage::Saving(waiting) => {
                waiting.push(held);
                return true;
            }
            Stage::Idle => *stage = Stage::Saving(vec![held]),
        }
        drop(stage);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if app.emit(FLUSH, ()).is_ok() {
                let _ = tokio::time::timeout(FLUSH_WAIT, app.state::<QuitFlush>().saved.notified()).await;
            }
            let held = match std::mem::replace(&mut *app.state::<QuitFlush>().stage.lock().unwrap_or_else(|e| e.into_inner()), Stage::Saved) {
                Stage::Saving(held) => held,
                Stage::Idle | Stage::Saved => Vec::new(),
            };
            for then in held {
                then();
            }
        });
        true
    }
}

/// The window's answer: its draft is saved.
#[tauri::command]
pub fn studio_flushed(flush: State<'_, QuitFlush>) {
    flush.saved.notify_one();
}

/// Opens the Files and Folders pane of macOS Privacy settings, where the person lets the app read Documents.
#[tauri::command]
pub fn studio_open_files_privacy() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")
            .status()
            .map_err(|e| format!("opening Privacy settings: {e}"))
            .and_then(|status| if status.success() { Ok(()) } else { Err(format!("opening Privacy settings ended with {status}")) })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Privacy settings for folders are a macOS setting.".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quit_asks_the_window_once_and_goes_on_without_an_answer() {
        let app = tauri::test::mock_app();
        app.manage(QuitFlush::default());
        let (done, finished) = std::sync::mpsc::channel();
        let (first, second) = (done.clone(), done.clone());
        assert!(QuitFlush::hold(app.handle(), move |_| first.send("close").unwrap()), "the close waits for the window");
        // A quit while the window still saves waits for the same save, then goes on too.
        assert!(QuitFlush::hold(app.handle(), move |_| second.send("quit").unwrap()), "the quit waits for that save");
        // No window answers in the mock, so the wait ends at its limit.
        let mut ran = [
            finished.recv_timeout(FLUSH_WAIT + Duration::from_secs(2)).expect("the close goes on"),
            finished.recv_timeout(Duration::from_secs(1)).expect("the quit goes on"),
        ];
        ran.sort();
        assert_eq!(ran, ["close", "quit"]);
        assert!(!QuitFlush::hold(app.handle(), move |_| done.send("again").unwrap()), "once saved, a quit goes through");
    }

    #[test]
    fn the_windows_answer_ends_the_wait_at_once() {
        let app = tauri::test::mock_app();
        app.manage(QuitFlush::default());
        let (done, finished) = std::sync::mpsc::channel();
        let started = std::time::Instant::now();
        assert!(QuitFlush::hold(app.handle(), move |_| done.send(()).unwrap()));
        std::thread::sleep(Duration::from_millis(50));
        studio_flushed(app.state::<QuitFlush>());
        finished.recv_timeout(FLUSH_WAIT).expect("the quit goes on");
        assert!(started.elapsed() < FLUSH_WAIT, "the answer ended the wait, after {:?}", started.elapsed());
    }
}
