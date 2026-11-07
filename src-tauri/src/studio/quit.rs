//! A normal quit, or closing the window, waits briefly for the window to save what the person typed but has not
//! saved yet. The window saves its draft a moment after typing pauses, so text typed just before a quit would be lost
//! without this. A restart for an update cannot be held: Tauri ignores a hold on it, and the update waits for idle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::Notify;

/// The event that asks the window to save its draft now.
const FLUSH: &str = "studio://flush";

/// How long a quit waits for the window. A window that does not answer, as one that is gone, never holds it longer.
const FLUSH_WAIT: Duration = Duration::from_millis(1500);

#[derive(Default)]
pub struct QuitFlush {
    /// Set once the window was asked, so the quit or close that follows the answer goes through.
    asked: AtomicBool,
    saved: Notify,
}

impl QuitFlush {
    /// Asks the window to save its draft, the first time only, and then runs `then`. Returns whether it asked, so the
    /// caller holds the quit or close until `then` runs.
    pub fn hold<R: Runtime>(app: &AppHandle<R>, then: impl FnOnce(AppHandle<R>) + Send + 'static) -> bool {
        let flush = app.state::<QuitFlush>();
        if flush.asked.swap(true, Ordering::SeqCst) {
            return false;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if app.emit(FLUSH, ()).is_ok() {
                let _ = tokio::time::timeout(FLUSH_WAIT, app.state::<QuitFlush>().saved.notified()).await;
            }
            then(app);
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
        let first = done.clone();
        assert!(QuitFlush::hold(app.handle(), move |_| first.send(()).unwrap()), "the first quit waits for the window");
        assert!(!QuitFlush::hold(app.handle(), move |_| done.send(()).unwrap()), "the quit that follows goes through");
        // No window answers in the mock, so the wait ends at its limit.
        finished.recv_timeout(FLUSH_WAIT + Duration::from_secs(2)).expect("the quit goes on");
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
