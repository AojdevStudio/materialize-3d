//! The PATH of the person's login shell. An app opened from Finder starts with only the system folders, where `uv` is
//! not.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// How long the login shell may take to tell its PATH before the app goes on without it.
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// The login shell's PATH, ahead of the app's own. The app ships on macOS, where zsh is the default shell, so zsh
/// stands in when `SHELL` is not set.
pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let current = std::env::var("PATH").unwrap_or_default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
        match shell_path(&shell, DEADLINE) {
            Some(path) if current.is_empty() => path,
            Some(path) => format!("{path}:{current}"),
            None => current,
        }
    })
}

/// The PATH `shell` reports as a login shell, or none when it fails, says nothing, or does not end within
/// `deadline`. A shell whose startup files hang is ended with all it started, so the sidecar still starts.
fn shell_path(shell: &str, deadline: std::time::Duration) -> Option<String> {
    let marker = "__M3D_PATH__";
    let end = std::time::Instant::now() + deadline;
    let mut command = std::process::Command::new(shell);
    command
        .args(["-ilc", &format!("printf '{marker}%s{marker}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // The shell leads a session of its own, so the deadline ends what its startup files started too. A session, not
    // only a group: a shell in a background group of the terminal the app started from stops before its startup
    // files, and one in a session of its own has no terminal to stop for.
    #[cfg(unix)]
    // SAFETY: setsid is async-signal-safe and only makes the child a session leader before it runs the shell.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // What the shell printed so far. A program its startup files started, such as an agent, can keep stdout open long
    // after the shell ends, so the reader is not waited on for its end. Once the lookup is done the reader stops at its
    // next read and closes the pipe, so a program that keeps writing is never read again.
    let printed = std::sync::Arc::new(Mutex::new(Vec::new()));
    let done = std::sync::Arc::new(AtomicBool::new(false));
    let (closed, eof) = std::sync::mpsc::channel::<()>();
    std::thread::spawn({
        let printed = printed.clone();
        let done = done.clone();
        move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n @ 1..) = std::io::Read::read(&mut stdout, &mut chunk) {
                if done.load(Ordering::Relaxed) {
                    break;
                }
                printed.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&chunk[..n]);
            }
            let _ = closed.send(());
        }
    });
    // Startup files can send stdout elsewhere and go on running, so the shell's end has the deadline too.
    let ended = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if std::time::Instant::now() < end => std::thread::sleep(std::time::Duration::from_millis(20)),
            _ => break false,
        }
    };
    // The shell has ended, so all it printed is in the pipe: a short wait lets the reader take it.
    let _ = eof.recv_timeout(std::time::Duration::from_millis(100));
    let out = ended.then(|| std::mem::take(&mut *printed.lock().unwrap_or_else(|e| e.into_inner())));
    done.store(true, Ordering::Relaxed);
    if !ended {
        #[cfg(unix)]
        if let Ok(group) = i32::try_from(child.id()) {
            // SAFETY: killpg only sends a signal, to the group this shell leads, as its session leader, and has not been
            // reaped from.
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    let out = out?;
    // The PATH is what the shell printed between the two markers. A program its startup files left running can write
    // after it, so nothing past the second marker counts.
    String::from_utf8_lossy(&out)
        .split_once(marker)
        .and_then(|(_, rest)| rest.split_once(marker))
        .map(|(path, _)| path.trim().to_owned())
        .filter(|path| !path.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_login_shell_that_hangs_is_ended_at_its_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("slow-shell");
        // The shell leaves a mark beside itself when it starts, so a shell that never started cannot pass for one the
        // deadline ended. The deadline leaves a busy runner time to start it.
        let mark = dir.path().join("started");
        let deadline = std::time::Duration::from_secs(1);
        crate::write_test_script(&shell, "#!/bin/sh\n: > \"$(dirname \"$0\")/started\"\nsleep 30\n");
        let started = std::time::Instant::now();
        assert_eq!(shell_path(shell.to_str().unwrap(), deadline), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
        assert!(mark.exists(), "the shell never started");

        // Startup files that send stdout elsewhere and then hang end at the deadline too.
        std::fs::remove_file(&mark).unwrap();
        crate::write_test_script(&shell, "#!/bin/sh\n: > \"$(dirname \"$0\")/started\"\nexec >/dev/null\nsleep 30\n");
        let started = std::time::Instant::now();
        assert_eq!(shell_path(shell.to_str().unwrap(), deadline), None);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "took {:?}", started.elapsed());
        assert!(mark.exists(), "the shell never started");
        assert!(shell_path("/bin/sh", std::time::Duration::from_secs(5)).is_some_and(|path| !path.is_empty()));
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_that_leaves_a_program_holding_its_output_still_gives_its_path_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("agent-shell");
        // Startup files that start an agent, which keeps the shell's stdout open after the shell ends.
        crate::write_test_script(&shell, "#!/bin/sh
sleep 30 &
printf '__M3D_PATH__/opt/tools/bin__M3D_PATH__'
");
        let started = std::time::Instant::now();
        assert_eq!(shell_path(shell.to_str().unwrap(), std::time::Duration::from_secs(5)).as_deref(), Some("/opt/tools/bin"));
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    #[cfg(unix)]
    #[test]
    fn a_program_that_keeps_writing_to_the_login_shells_output_is_not_read_after_the_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("noisy-shell");
        let pid = dir.path().join("pid");
        crate::write_test_script(&shell, &format!("#!/bin/sh\nyes &\necho $! > {}\nprintf '__M3D_PATH__/opt/tools/bin__M3D_PATH__'\n", pid.display()));
        assert_eq!(shell_path(shell.to_str().unwrap(), std::time::Duration::from_secs(5)).as_deref(), Some("/opt/tools/bin"));
        let pid = std::fs::read_to_string(&pid).unwrap().trim().parse::<i32>().unwrap();
        // Once nothing reads the pipe, the next write ends the writer. An ended writer may wait as a zombie until the
        // system reaps it, so that counts as ended too.
        let ended = || {
            let state = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().expect("ps");
            let state = String::from_utf8_lossy(&state.stdout);
            state.trim().is_empty() || state.trim_start().starts_with('Z')
        };
        let gone = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            ended()
        });
        if !gone {
            // SAFETY: ends the test's own writer, which outlived the lookup.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        assert!(gone, "the lookup still read the output of a program its shell left running");
    }
}
