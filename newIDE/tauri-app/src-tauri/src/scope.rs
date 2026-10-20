//! `scope_allow_project_dir` — backend for `TauriBridge.allowProjectDirectory()`.
//! See TauriBridge-contract.md §0/§3.

use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::FsExt;

use crate::error::CommandError;

/// Extends both the fs-plugin scope and the asset-protocol scope to `directory_path`,
/// recursively. Call on every project open/save-as/recent-list open (plugin-dialog
/// only adds the single picked file, not sibling resources or split-JSON folders).
#[tauri::command]
pub fn scope_allow_project_dir<R: Runtime>(
    app: AppHandle<R>,
    directory_path: String,
) -> Result<(), CommandError> {
    let path = PathBuf::from(&directory_path);

    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|e| {
            CommandError::with_path(
                "IO",
                format!("failed to extend fs scope: {e}"),
                directory_path.clone(),
            )
        })?;

    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| {
            CommandError::with_path(
                "IO",
                format!("failed to extend asset-protocol scope: {e}"),
                directory_path,
            )
        })?;

    Ok(())
}
