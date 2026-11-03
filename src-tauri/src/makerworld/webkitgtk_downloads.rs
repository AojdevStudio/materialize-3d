use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Barrier, Mutex},
    thread,
    time::{Duration, Instant},
};

use gtk::prelude::*;
use wry::{WebViewBuilder, WebViewBuilderExtUnix};

use super::{DownloadStart, PendingDownloads};

const BODY_LEN: usize = 256 * 1024;

#[derive(Clone, Copy, Debug)]
enum Outcome {
    Refused,
    Fails,
    Lands,
}

#[derive(Debug)]
struct Finish {
    url: String,
    path: Option<PathBuf>,
    success: bool,
}

fn body() -> Vec<u8> {
    (0..BODY_LEN).map(|index| (index % 251) as u8).collect()
}

/// Both transfers of an `/overlap/` path stop halfway until the test has seen both starts.
/// The first transfer of an `/overlap/fails/` path then ends with a reset.
#[derive(Default)]
struct Overlap {
    both_started: Option<Barrier>,
    seen: Mutex<HashSet<String>>,
}

fn serve(listener: TcpListener, overlap: Arc<Overlap>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { return };
        let overlap = Arc::clone(&overlap);
        thread::spawn(move || respond(stream, &overlap));
    }
}

fn reset(stream: &TcpStream) {
    // WebKitGTK reports a clean close before Content-Length as a success (#104), so the failure is a reset.
    socket2::SockRef::from(stream)
        .set_linger(Some(Duration::ZERO))
        .expect("reset on close");
}

fn respond(mut stream: TcpStream, overlap: &Overlap) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone the connection"));
    let mut request_line = String::new();
    reader.read_line(&mut request_line).expect("read the request line");
    let mut header = String::new();
    while reader.read_line(&mut header).expect("read a header") > 2 {
        header.clear();
    }

    let path = request_line.split_whitespace().nth(1).unwrap_or_default().to_string();
    let file = path.rsplit('/').next().unwrap_or_default();
    let body = body();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"{file}\"\r\nContent-Length: {BODY_LEN}\r\nConnection: close\r\n\r\n"
    );
    // Recorded before the headers, which trigger the start, so the first request is the first start.
    let first = overlap.seen.lock().expect("seen paths").insert(path.clone());
    let _ = stream.write_all(head.as_bytes());

    if let (Some(both_started), true) = (&overlap.both_started, path.starts_with("/overlap/")) {
        let _ = stream.write_all(&body[..BODY_LEN / 2]);
        both_started.wait();
        if first && path.starts_with("/overlap/fails/") {
            reset(&stream);
        } else {
            let _ = stream.write_all(&body[BODY_LEN / 2..]);
        }
        return;
    } else if file.starts_with("fails") {
        let _ = stream.write_all(&body[..BODY_LEN / 2]);
        reset(&stream);
        return;
    }
    let _ = stream.write_all(&body);
}

fn pump_until<T>(receiver: &mpsc::Receiver<T>, what: &str) -> T {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        gtk::main_iteration_do(false);
        if let Ok(value) = receiver.try_recv() {
            return value;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("no {what} within 30 s");
}

fn wait_for_finish(receiver: &mpsc::Receiver<Finish>, url: &str) -> Finish {
    let finish = pump_until(receiver, &format!("finish event for {url}"));
    assert_eq!(finish.url, url, "finish events arrive in download order");
    finish
}

fn assert_landed(path: &Path) {
    assert!(fs::read(path).expect("read the download") == body(), "{} landed complete", path.display());
}

// GTK runs on one thread per process, so every WebKitGTK scenario runs under one test.
#[test]
#[ignore = "drives real WebKitGTK and needs a display. CI runs it under xvfb-run"]
fn webkitgtk_downloads() {
    gtk::init().expect("GTK needs a display");
    a_refused_or_failed_download_leaves_later_downloads_successful();
    two_overlapping_downloads_of_one_url_each_land_in_their_own_file();
    two_overlapping_downloads_of_one_url_started_on_two_models_each_finish_with_their_own_start();
}

fn a_refused_or_failed_download_leaves_later_downloads_successful() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
    let origin = format!("http://{}", listener.local_addr().expect("local address"));
    thread::spawn(move || serve(listener, Arc::default()));

    let downloads = tempfile::tempdir().expect("temp download dir");
    let destinations = downloads.path().to_path_buf();
    let (sender, receiver) = mpsc::channel();

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
    window.add(&container);
    let webview = WebViewBuilder::new()
        .with_download_started_handler(move |url, destination| {
            let file = url.rsplit('/').next().unwrap_or_default().to_string();
            *destination = destinations.join(&file);
            !file.starts_with("refused")
        })
        .with_download_completed_handler(move |url, path, success| {
            let _ = sender.send(Finish { url, path, success });
        })
        .build_gtk(&container)
        .expect("build the webview");
    window.show_all();

    let steps = [
        ("refused.3mf", Outcome::Refused),
        ("first.3mf", Outcome::Lands),
        ("fails.3mf", Outcome::Fails),
        ("second.3mf", Outcome::Lands),
    ];
    for (file, outcome) in steps {
        let url = format!("{origin}/{file}");
        webview.load_url(&url).expect("start the download");
        let finish = wait_for_finish(&receiver, &url);
        match outcome {
            Outcome::Refused | Outcome::Fails => {
                assert!(!finish.success, "{file} must report failure: {finish:?}");
            }
            Outcome::Lands => {
                assert!(finish.success, "{file} must report success after an earlier failure: {finish:?}");
                let path = finish.path.expect("a successful finish carries its path");
                assert_eq!(path, downloads.path().join(file));
                assert_landed(&path);
            }
        }
    }
}

fn two_overlapping_downloads_of_one_url_each_land_in_their_own_file() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
    let origin = format!("http://{}", listener.local_addr().expect("local address"));
    let overlap = Arc::new(Overlap { both_started: Some(Barrier::new(3)), ..Overlap::default() });
    let server = Arc::clone(&overlap);
    thread::spawn(move || serve(listener, server));

    let downloads = tempfile::tempdir().expect("temp download dir");
    let folder = downloads.path().to_path_buf();
    let pending = Arc::new(Mutex::new(PendingDownloads::default()));
    let (started_sender, started) = mpsc::channel();
    let (finish_sender, finished) = mpsc::channel();

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
    window.add(&container);
    let on_start = Arc::clone(&pending);
    let on_finish = Arc::clone(&pending);
    let webview = WebViewBuilder::new()
        .with_download_started_handler(move |url, destination| {
            let file = url.rsplit('/').next().unwrap_or_default().to_string();
            let start = DownloadStart { model_dir: folder.clone(), model: None, source_url: url.clone() };
            *destination = on_start.lock().unwrap().start(&url, start, &file);
            let _ = started_sender.send(());
            true
        })
        .with_download_completed_handler(move |url, path, success| {
            let path = on_finish.lock().unwrap().finish(&url, path, success).map(|reservation| reservation.destination);
            let _ = finish_sender.send(Finish { url, path, success });
        })
        .build_gtk(&container)
        .expect("build the webview");
    window.show_all();

    let start_twice = |url: &str| -> Vec<Finish> {
        webview.load_url(url).expect("start the first download");
        pump_until(&started, "first start");
        webview.load_url(url).expect("start the second download");
        pump_until(&started, "second start");
        overlap.both_started.as_ref().expect("an overlap barrier").wait();
        let mut finishes = vec![pump_until(&finished, "first finish"), pump_until(&finished, "second finish")];
        finishes.sort_by_key(|finish| !finish.success);
        assert!(finishes.iter().all(|finish| finish.url == url), "{finishes:?}");
        finishes
    };

    let both_land = start_twice(&format!("{origin}/overlap/same.3mf"));
    assert!(both_land.iter().all(|finish| finish.success), "both transfers succeed: {both_land:?}");
    let landed: HashSet<PathBuf> = both_land.into_iter().filter_map(|finish| finish.path).collect();
    assert_eq!(
        landed,
        HashSet::from([downloads.path().join("same.3mf"), downloads.path().join("same (1).3mf")]),
    );
    landed.iter().for_each(|path| assert_landed(path));

    let one_fails = start_twice(&format!("{origin}/overlap/fails/same.3mf"));
    assert!(one_fails[0].success && !one_fails[1].success, "the reset transfer fails, the other lands: {one_fails:?}");
    let survivor = one_fails[0].path.clone().expect("a successful finish carries its path");
    assert_eq!(survivor, downloads.path().join("same (3).3mf"));
    assert_landed(&survivor);

    let later = format!("{origin}/later.3mf");
    webview.load_url(&later).expect("start a later download");
    let finish = wait_for_finish(&finished, &later);
    assert!(finish.success, "a later download still lands: {finish:?}");
    assert_landed(&downloads.path().join("later.3mf"));
    assert!(pending.lock().unwrap().by_url.is_empty(), "every transfer released its reservation");
}

fn two_overlapping_downloads_of_one_url_started_on_two_models_each_finish_with_their_own_start() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
    let origin = format!("http://{}", listener.local_addr().expect("local address"));
    let overlap = Arc::new(Overlap { both_started: Some(Barrier::new(3)), ..Overlap::default() });
    let server = Arc::clone(&overlap);
    thread::spawn(move || serve(listener, server));

    let downloads = tempfile::tempdir().expect("temp download dir");
    let dispenser = downloads.path().join("dispenser");
    let hook = downloads.path().join("hook");
    let model_dirs = Mutex::new(vec![hook.clone(), dispenser.clone()]);
    let pending = Arc::new(Mutex::new(PendingDownloads::default()));
    let (started_sender, started) = mpsc::channel();
    let (finish_sender, finished) = mpsc::channel();

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let container = gtk::Box::new(gtk::Orientation::Vertical, 0);
    window.add(&container);
    let on_start = Arc::clone(&pending);
    let on_finish = Arc::clone(&pending);
    let webview = WebViewBuilder::new()
        .with_download_started_handler(move |url, destination| {
            let model_dir = model_dirs.lock().unwrap().pop().expect("one model folder per start");
            fs::create_dir_all(&model_dir).expect("create the model folder");
            let start = DownloadStart { model_dir, model: None, source_url: url.clone() };
            *destination = on_start.lock().unwrap().start(&url, start, "same.3mf");
            let _ = started_sender.send(());
            true
        })
        .with_download_completed_handler(move |url, path, success| {
            let reservation = on_finish.lock().unwrap().finish(&url, path.clone(), success);
            let _ = finish_sender.send((path, reservation.map(|reservation| reservation.start.model_dir)));
        })
        .build_gtk(&container)
        .expect("build the webview");
    window.show_all();

    let url = format!("{origin}/overlap/same.3mf");
    webview.load_url(&url).expect("start the download on the dispenser");
    pump_until(&started, "dispenser start");
    webview.load_url(&url).expect("start the download on the hook");
    pump_until(&started, "hook start");
    overlap.both_started.as_ref().expect("an overlap barrier").wait();

    let finishes = HashSet::from([pump_until(&finished, "first finish"), pump_until(&finished, "second finish")]);
    assert_eq!(
        finishes,
        HashSet::from([
            (Some(dispenser.join("same.3mf")), Some(dispenser.clone())),
            (Some(hook.join("same.3mf")), Some(hook.clone())),
        ]),
        "each finish takes back the reservation of its own start",
    );
    assert_landed(&dispenser.join("same.3mf"));
    assert_landed(&hook.join("same.3mf"));
    assert!(pending.lock().unwrap().by_url.is_empty(), "every transfer released its reservation");
}
