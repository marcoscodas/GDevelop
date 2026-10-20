//! `preview_window_open` / `preview_window_close` / `preview_window_close_all`.
//! See TauriBridge-contract.md §0/§3.

use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::error::CommandError;
use crate::preview_server::PreviewServerState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWindowOptions {
    /// Must start with the running PreviewServer's origin; rejected otherwise.
    pub url: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub always_on_top: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWindowHandle {
    pub label: String,
}

/// Monotonically-increasing counter for `preview-<n>` labels. Never reused,
/// even across closes, so a late event for a stale label can't be confused
/// with a new window.
#[derive(Default)]
pub struct PreviewWindowCounter(AtomicU32);

impl PreviewWindowCounter {
    fn next_label(&self) -> String {
        let n = self.0.fetch_add(1, Ordering::Relaxed) + 1;
        format!("preview-{n}")
    }
}

/// Opens a top-level preview window on a preview-server URL. The window gets
/// **no** capability file (it is not in any `capabilities/*.json` `windows`
/// list), so it has no IPC access at all.
#[tauri::command]
pub fn preview_window_open<R: Runtime>(
    app: AppHandle<R>,
    server_state: tauri::State<'_, PreviewServerState>,
    counter: tauri::State<'_, PreviewWindowCounter>,
    options: PreviewWindowOptions,
) -> Result<PreviewWindowHandle, CommandError> {
    let origin = server_state
        .current_origin()
        .ok_or_else(|| CommandError::out_of_scope("no preview server is running".to_string()))?;

    if !options.url.starts_with(&origin) {
        return Err(CommandError::out_of_scope(options.url));
    }

    let url = options
        .url
        .parse::<tauri::Url>()
        .map_err(|e| CommandError::window(format!("invalid preview URL: {e}")))?;

    let label = counter.next_label();

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title(options.title)
        .inner_size(options.width, options.height)
        .always_on_top(options.always_on_top)
        .build()
        .map_err(|e| CommandError::window(format!("failed to open preview window: {e}")))?;

    let app_handle_for_event = app.clone();
    let emit_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = app_handle_for_event.emit("preview-window-closed", emit_label.clone());
        }
    });

    log::info!("preview_window: opened {label} at {}", options.url);

    Ok(PreviewWindowHandle { label })
}

/// Closes one preview window; resolves (no error) if it is already closed or
/// never existed.
#[tauri::command]
pub fn preview_window_close<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|e| CommandError::window(format!("failed to close {label}: {e}")))?;
    }
    Ok(())
}

/// Closes every open preview window (label prefix `preview-`). The main
/// window is never touched.
#[tauri::command]
pub fn preview_window_close_all<R: Runtime>(app: AppHandle<R>) -> Result<(), CommandError> {
    for (label, window) in app.webview_windows() {
        if label.starts_with("preview-") {
            let _ = window.close();
        }
    }
    Ok(())
}
