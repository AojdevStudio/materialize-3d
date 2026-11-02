use std::{
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use gtk::prelude::*;
use wry::{WebViewBuilder, WebViewBuilderExtUnix};

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

fn serve(listener: TcpListener) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { return };
        thread::spawn(move || respond(stream));
    }
}

fn respond(mut stream: TcpStream) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone the connection"));
    let mut request_line = String::new();
    reader.read_line(&mut request_line).expect("read the request line");
    let mut header = String::new();
    while reader.read_line(&mut header).expect("read a header") > 2 {
        header.clear();
    }

    let file = request_line.split_whitespace().nth(1).unwrap_or_default().trim_start_matches('/');
    let body = body();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"{file}\"\r\nContent-Length: {BODY_LEN}\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(head.as_bytes());
    if file.starts_with("fails") {
        let _ = stream.write_all(&body[..BODY_LEN / 2]);
        // WebKitGTK reports a clean close before Content-Length as a success, so the failure is a reset.
        socket2::SockRef::from(&stream)
            .set_linger(Some(Duration::ZERO))
            .expect("reset on close");
    } else {
        let _ = stream.write_all(&body);
    }
}

fn wait_for_finish(receiver: &mpsc::Receiver<Finish>, url: &str) -> Finish {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        gtk::main_iteration_do(false);
        if let Ok(finish) = receiver.try_recv() {
            assert_eq!(finish.url, url, "finish events arrive in download order");
            return finish;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("no finish event for {url} within 30 s");
}

#[test]
#[ignore = "drives real WebKitGTK and needs a display. CI runs it under xvfb-run"]
fn a_refused_or_failed_download_leaves_later_downloads_successful() {
    gtk::init().expect("GTK needs a display");

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
    let origin = format!("http://{}", listener.local_addr().expect("local address"));
    thread::spawn(move || serve(listener));

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
                assert!(fs::read(&path).expect("read the download") == body(), "{file} landed complete");
            }
        }
    }
}
