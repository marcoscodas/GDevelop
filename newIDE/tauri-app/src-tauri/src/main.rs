// GDevelop 5 Tauri shell. Commands implement TauriBridge-contract.md;
// JS consumes them through Utils/Tauri/TauriBridge.js.
//
// Console window stays attached in release (normally suppressed by
// `windows_subsystem = "windows"`) so logs are visible without a debugger.

mod env;
mod error;
mod fs_cmds;
mod http_fetch;
mod preview_server;
mod preview_window;
mod scope;

use log::LevelFilter;
use preview_server::PreviewServerState;
use preview_window::PreviewWindowCounter;
use tauri_plugin_log::{Target, TargetKind};

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(LevelFilter::Debug)
                // Crate name = package name "gdevelop" (no [[bin]] override).
                .level_for("gdevelop", LevelFilter::Trace)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    // Also visible in devtools when it's open.
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(PreviewServerState::default())
        .manage(PreviewWindowCounter::default())
        .invoke_handler(tauri::generate_handler![
            env::app_env,
            scope::scope_allow_project_dir,
            fs_cmds::fs_stat_many,
            fs_cmds::flush_export,
            http_fetch::http_fetch,
            preview_server::preview_server_start,
            preview_server::preview_server_stop,
            preview_window::preview_window_open,
            preview_window::preview_window_close,
            preview_window::preview_window_close_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
