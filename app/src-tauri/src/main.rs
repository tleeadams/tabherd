// Tabherd in a window of its own. Starts the dashboard server, the bundled
// Node running server.js, unless a Tabherd server already answers on the
// port, and shows the dashboard in the system's web view. Links that would
// open a new window open in the default browser. Quitting stops the server
// this app started, never one it found running. The dashboard's Settings can
// keep the window on top of others and, on Windows, make it see-through. The
// window has no title bar of the system's: the dashboard's header stands in
// for it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

const DEFAULT_PORT: u16 = 4317;
const START_TIMEOUT: Duration = Duration::from_secs(30);

// The server this app started, stopped when it quits.
struct Server(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn dashboard_url(port: u16) -> Url {
    format!("http://localhost:{port}/")
        .parse()
        .expect("a valid URL")
}

// Whether a Tabherd server answers on the port: its page has Tabherd's title,
// as `server.js --open` checks.
fn is_dashboard(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = format!("GET / HTTP/1.0\r\nHost: localhost:{port}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response);
    text.starts_with("HTTP/1.1 200") && text.contains("<title>Tabherd</title>")
}

// Windows gives paths as \\?\C:\…, which Node has no need of.
fn plain(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

// The bundled Node, beside this program, runs server.js from the app's
// resources. Run from the source, with no Node beside it, the one on the PATH
// does. Its output goes to server.log in the app's log folder. This program is
// found through any link to it, as winget starts a portable app through one in
// its Links folder: Tauri's current_exe follows links, as it does to find the
// resources.
fn start_server(app: &AppHandle, port: u16) -> Result<(Child, PathBuf), String> {
    let exe = plain(tauri::utils::platform::current_exe().map_err(|e| e.to_string())?);
    // On Linux it's tabherd-node, as the packages put it in /usr/bin, beside
    // any node the system has.
    let name = if cfg!(windows) {
        "node.exe"
    } else if cfg!(target_os = "linux") {
        "tabherd-node"
    } else {
        "node"
    };
    let bundled = exe.with_file_name(name);
    let node = if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    };
    let root = plain(app.path().resource_dir().map_err(|e| e.to_string())?).join("server");
    let script = root.join("server.js");
    if !script.exists() {
        return Err(format!(
            "The dashboard's server.js isn't at {}.",
            script.display()
        ));
    }
    let logs = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log_path = logs.join("server.log");
    let log = File::create(&log_path).map_err(|e| e.to_string())?;
    let errors = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(&node);
    command
        .arg(&script)
        // A safety net: if this app is killed without stopping it, the server
        // stops itself 10 minutes after the last dashboard closes.
        .arg("--exit-when-idle")
        .env("PORT", port.to_string())
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(errors);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("Couldn't start {}: {e}", node.display()))?;
    Ok((child, log_path))
}

// Uses the server already answering on the port, or starts one and waits for
// it to answer.
fn connect(app: &AppHandle, port: u16) -> Result<(), String> {
    if is_dashboard(port) {
        return Ok(());
    }
    let (child, log) = start_server(app, port)?;
    let server = app.state::<Server>();
    server.0.lock().unwrap().replace(child);
    let started = Instant::now();
    loop {
        if is_dashboard(port) {
            return Ok(());
        }
        if let Some(child) = server.0.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!(
                    "The dashboard server stopped as it started ({status}). What it said is in {}.",
                    log.display()
                ));
            }
        }
        if started.elapsed() > START_TIMEOUT {
            return Err(format!(
                "The dashboard server didn't answer on port {port}. What it said is in {}.",
                log.display()
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

// This app's own page and the dashboard load in the window; anything else
// opens in the default browser.
fn is_local(url: &Url, port: u16) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") | Some("127.0.0.1") => url.port_or_known_default() == Some(port),
            _ => false,
        },
        _ => false,
    }
}

#[cfg(windows)]
fn browser_args() -> String {
    // Wry's own arguments, which giving any replaces, then sound without a
    // click first.
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required");
    // A debug build can be driven over the DevTools protocol, for the checks
    // in dist/e2e.
    if cfg!(debug_assertions) {
        args.push_str(" --remote-debugging-port=9223");
    }
    args
}

// Keeps the window above other windows, or not. The dashboard calls it from
// Settings and its pin button, and again as it loads, since the setting is
// kept in its own storage. The only command the page may call; see
// capabilities/dashboard.json.
#[tauri::command]
fn set_on_top(window: Window, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

// Whether the page in the window stands in for its title bar. The window
// starts without the system's, for the dashboard and the starting page.
static OWN_TITLE_BAR: AtomicBool = AtomicBool::new(true);

// Gives the window the system's title bar back, or takes it away again. Each
// page says as it loads whether it stands in for it, with a tabherd-title-bar
// meta tag: one from an older server, found running on the port, doesn't, and
// nor does an error page of the web view's.
#[tauri::command]
fn own_title_bar(window: Window, own: bool) -> Result<(), String> {
    if OWN_TITLE_BAR.swap(own, Ordering::SeqCst) == own {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let changed = window.set_title_bar_style(if own {
        tauri::TitleBarStyle::Overlay
    } else {
        tauri::TitleBarStyle::Visible
    });
    #[cfg(not(target_os = "macos"))]
    let changed = window.set_decorations(!own);
    changed.map_err(|e| e.to_string())
}

// What this window can do, for the dashboard to offer: setOnTop(on), and
// seeThrough, whether its background can be see-through, which is up to the
// page. macOS would need Apple's private API for that, and Linux is untried.
// titleBar says how the page stands in for the title bar: "buttons", with the
// window's buttons, which minimize(), toggleMaximize(), isMaximized() and
// close() work, or "inset", leaving room for macOS's own in the top left.
// Moving the window is Tauri's: dragging an element marked
// data-tauri-drag-region, and double-clicking it to maximize.
fn app_script() -> String {
    let title_bar = if cfg!(target_os = "macos") {
        "inset"
    } else {
        "buttons"
    };
    format!(
        r#"(() => {{
  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
  window.tabherdApp = {{
    seeThrough: {see_through},
    setOnTop: (on) => invoke('set_on_top', {{ on }}),
    titleBar: '{title_bar}',
    minimize: () => invoke('plugin:window|minimize'),
    toggleMaximize: () => invoke('plugin:window|toggle_maximize'),
    isMaximized: () => invoke('plugin:window|is_maximized'),
    close: () => invoke('plugin:window|close'),
  }};
  addEventListener('DOMContentLoaded', () => {{
    invoke('own_title_bar', {{ own: !!document.querySelector('meta[name="tabherd-title-bar"]') }});
  }});
}})();"#,
        see_through = cfg!(windows),
    )
}

fn build_window(app: &AppHandle, port: u16) -> tauri::Result<WebviewWindow> {
    let links = app.clone();
    let popups = app.clone();
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Tabherd")
        .inner_size(1280.0, 860.0)
        .min_inner_size(420.0, 320.0)
        .initialization_script(app_script())
        .on_navigation(move |url| {
            if is_local(url, port) {
                return true;
            }
            let _ = links.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        // target="_blank" and window.open.
        .on_new_window(move |url, _features| {
            let _ = popups.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        // The page's title counts the sessions waiting on you.
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });
    // The page's header is the title bar. macOS keeps its own window buttons,
    // over the header's top left corner.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    // Transparent, so the page's background decides how see-through it is:
    // opaque unless Settings says otherwise.
    #[cfg(windows)]
    let builder = builder
        .additional_browser_args(&browser_args())
        .transparent(true);
    builder.build()
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch brings this one's window forward instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show(app)
        }))
        .plugin(tauri_plugin_opener::init())
        // Not whether it has the system's title bar, which own_title_bar
        // decides.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() - StateFlags::DECORATIONS)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![set_on_top, own_title_bar])
        .setup(|app| {
            let port = port();
            app.manage(Server(Mutex::new(None)));
            // The window shows "Starting Tabherd…" until the server answers.
            let window = build_window(app.handle(), port)?;
            let handle = app.handle().clone();
            thread::spawn(move || match connect(&handle, port) {
                Ok(()) => {
                    let _ = window.navigate(dashboard_url(port));
                }
                Err(message) => {
                    let quoted = serde_json::to_string(&message).unwrap_or_default();
                    let _ = window.eval(format!("showError({quoted})"));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tabherd couldn't start");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
