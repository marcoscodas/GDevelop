//! `preview_server_start` / `preview_server_stop` — a minimal, loopback-only
//! static file server for previews. See TauriBridge-contract.md §0/§3.
//!
//! Hand-rolled over `std::net::TcpListener` rather than pulling in an async web
//! framework: this only ever serves a handful of static files to a local
//! webview window, there is no need for anything heavier.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;

use crate::error::CommandError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServer {
    /// e.g. "http://127.0.0.1:53817" — always loopback, never 0.0.0.0.
    pub origin: String,
    pub port: u16,
    pub root: String,
}

struct RunningServer {
    stop_flag: Arc<AtomicBool>,
    accept_thread: JoinHandle<()>,
    port: u16,
}

#[derive(Default)]
pub struct PreviewServerState(Mutex<Option<RunningServer>>);

impl PreviewServerState {
    /// The running server's origin, if any. Used by `preview_window_open` to
    /// reject URLs that don't belong to it.
    pub fn current_origin(&self) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| format!("http://127.0.0.1:{}", s.port))
    }
}

fn mime_type_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        // BMFont (.fnt) and Pixi/Spine (.atlas) descriptors are plain text.
        "fnt" | "atlas" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex_str, 16) {
                    out.push(byte);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn write_status_and_headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    content_length: usize,
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {content_length}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(header.as_bytes())
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write_status_and_headers(stream, status, reason, content_type, body.len())?;
    stream.write_all(body)
}

/// Resolves a decoded request path against `canonical_root`, rejecting
/// anything that escapes it (`..` segments, symlinks resolving outside, etc).
fn resolve_request_path(canonical_root: &Path, decoded_path: &str) -> Option<PathBuf> {
    let relative = decoded_path.trim_start_matches('/');
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };

    // Reject traversal attempts before touching the filesystem.
    if relative.split('/').any(|segment| segment == "..") {
        return None;
    }

    let candidate = canonical_root.join(relative);
    let mut resolved = fs::canonicalize(&candidate).ok()?;

    if !resolved.starts_with(canonical_root) {
        return None;
    }

    if resolved.is_dir() {
        resolved = fs::canonicalize(resolved.join("index.html")).ok()?;
        if !resolved.starts_with(canonical_root) {
            return None;
        }
    }

    if resolved.is_file() {
        Some(resolved)
    } else {
        None
    }
}

fn handle_connection(mut stream: TcpStream, canonical_root: &Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();

    let mut buf = [0u8; 8192];
    let mut data = Vec::new();
    loop {
        let n = stream.read(&mut buf)?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if data.windows(4).any(|w| w == b"\r\n\r\n") || data.len() > 64 * 1024 {
            break;
        }
    }

    let request = String::from_utf8_lossy(&data);
    let request_line = request.lines().next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_path = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        return write_response(
            &mut stream,
            405,
            "Method Not Allowed",
            "text/plain; charset=utf-8",
            b"Method Not Allowed",
        );
    }

    let path_only = raw_path.split('?').next().unwrap_or("/");
    let decoded = percent_decode(path_only);

    match resolve_request_path(canonical_root, &decoded) {
        Some(resolved) => match fs::read(&resolved) {
            Ok(body) => {
                let content_type = mime_type_for(&resolved);
                log::trace!("preview_server: 200 {method} {decoded} ({} bytes)", body.len());
                if method == "HEAD" {
                    write_status_and_headers(&mut stream, 200, "OK", content_type, body.len())
                } else {
                    write_response(&mut stream, 200, "OK", content_type, &body)
                }
            }
            Err(e) => {
                log::warn!("preview_server: 500 {method} {decoded} (read failed: {e})");
                write_response(
                    &mut stream,
                    500,
                    "Internal Server Error",
                    "text/plain; charset=utf-8",
                    b"Internal Server Error",
                )
            }
        },
        // The single most useful log line for diagnosing a broken preview:
        // every missing asset the preview page actually requested, by path.
        None => {
            log::warn!("preview_server: 404 {method} {decoded}");
            write_response(&mut stream, 404, "Not Found", "text/plain; charset=utf-8", b"Not Found")
        }
    }
}

fn accept_loop(listener: TcpListener, root: PathBuf, stop_flag: Arc<AtomicBool>) {
    if listener.set_nonblocking(true).is_err() {
        return;
    }

    while !stop_flag.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let root = root.clone();
                std::thread::spawn(move || {
                    let _ = handle_connection(stream, &root);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }
}

fn stop_running(state: &PreviewServerState) {
    let running = state.0.lock().unwrap().take();
    if let Some(running) = running {
        running.stop_flag.store(true, Ordering::Relaxed);
        // The accept loop polls the flag roughly every 25ms, so this join
        // returns quickly.
        let _ = running.accept_thread.join();
    }
}

/// Starts (or re-points, stopping any previous instance first) the loopback
/// static server on `root`. Idempotent: calling it again just restarts the
/// server on the new root and returns a new ephemeral port.
#[tauri::command]
pub fn preview_server_start(
    state: tauri::State<'_, PreviewServerState>,
    root: String,
) -> Result<PreviewServer, CommandError> {
    stop_running(&state);

    let root_path = PathBuf::from(&root);
    std::fs::create_dir_all(&root_path)
        .map_err(|e| CommandError::io(format!("failed to prepare preview root: {e}")))?;
    let canonical_root = std::fs::canonicalize(&root_path)
        .map_err(|e| CommandError::io(format!("failed to canonicalize preview root: {e}")))?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| CommandError::port_unavailable(format!("failed to bind preview server: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| CommandError::port_unavailable(format!("failed to read bound port: {e}")))?
        .port();

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = stop_flag.clone();
    let thread_root = canonical_root.clone();
    let accept_thread =
        std::thread::spawn(move || accept_loop(listener, thread_root, thread_stop_flag));

    *state.0.lock().unwrap() = Some(RunningServer {
        stop_flag,
        accept_thread,
        port,
    });

    log::info!(
        "preview_server: started on http://127.0.0.1:{port}, root={}",
        canonical_root.display()
    );

    Ok(PreviewServer {
        origin: format!("http://127.0.0.1:{port}"),
        port,
        root: canonical_root.to_string_lossy().into_owned(),
    })
}

/// Stops the server if running; no-op otherwise.
#[tauri::command]
pub fn preview_server_stop(state: tauri::State<'_, PreviewServerState>) -> Result<(), CommandError> {
    stop_running(&state);
    Ok(())
}
