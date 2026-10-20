//! `app_env` — backend for `TauriBridge.init()`. See TauriBridge-contract.md §0/§2.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::CommandError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TauriBridgeEnv {
    /// "windows" | "macos" | "linux" (std::env::consts::OS; matches the contract's
    /// TauriPlatform union for the platforms Wave 1 targets).
    pub platform: String,
    pub path_separator: String,
    pub app_cache_dir: String,
    pub document_dir: String,
    pub app_version: String,
}

#[tauri::command]
pub fn app_env<R: Runtime>(app: AppHandle<R>) -> Result<TauriBridgeEnv, CommandError> {
    let platform = std::env::consts::OS.to_string();
    let path_separator = if platform == "windows" { "\\" } else { "/" }.to_string();

    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| CommandError::io(format!("failed to resolve app cache dir: {e}")))?;
    let document_dir = app
        .path()
        .document_dir()
        .map_err(|e| CommandError::io(format!("failed to resolve document dir: {e}")))?;

    Ok(TauriBridgeEnv {
        platform,
        path_separator,
        app_cache_dir: app_cache_dir.to_string_lossy().into_owned(),
        document_dir: document_dir.to_string_lossy().into_owned(),
        app_version: app.package_info().version.to_string(),
    })
}
