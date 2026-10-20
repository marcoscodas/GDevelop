// GDevelop 5 Tauri shell.
//
// Custom commands implement the Rust side of `TauriBridge-contract.md` (v1,
// frozen for Wave 1). JS consumes them exclusively through
// `newIDE/app/src/Utils/Tauri/TauriBridge.js` (B1).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod env;
mod error;
mod fs_cmds;
mod preview_server;
mod preview_window;
mod scope;

use preview_server::PreviewServerState;
use preview_window::PreviewWindowCounter;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(PreviewServerState::default())
        .manage(PreviewWindowCounter::default())
        .invoke_handler(tauri::generate_handler![
            env::app_env,
            scope::scope_allow_project_dir,
            fs_cmds::fs_stat_many,
            fs_cmds::flush_export,
            preview_server::preview_server_start,
            preview_server::preview_server_stop,
            preview_window::preview_window_open,
            preview_window::preview_window_close,
            preview_window::preview_window_close_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
