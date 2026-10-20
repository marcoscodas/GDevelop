// GDevelop 5 Tauri shell.
//
// Custom commands implement the Rust side of `TauriBridge-contract.md` (v1,
// frozen for Wave 1). JS consumes them exclusively through
// `newIDE/app/src/Utils/Tauri/TauriBridge.js` (B1).
//
// MVP diagnostics build: keeps the console window in release too (normally
// suppressed by `windows_subsystem = "windows"`) and ships verbose logging
// (see the `tauri-plugin-log` registration below) so a tester can report
// what actually happened without attaching a debugger. Revisit both once the
// MVP is past the "does this even work" phase.

mod env;
mod error;
mod fs_cmds;
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
                // Our own command modules (crate name = package name
                // "gdevelop", no [[bin]] override) at full verbosity; keep
                // wry/tao's internal chatter at Debug so the log stays
                // readable.
                .level_for("gdevelop", LevelFilter::Trace)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    // Mirrors Rust-side logs into the webview's own devtools
                    // console too, so everything is visible in one place
                    // when devtools is open (right-click > Inspect, or F12).
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
            preview_server::preview_server_start,
            preview_server::preview_server_stop,
            preview_window::preview_window_open,
            preview_window::preview_window_close,
            preview_window::preview_window_close_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
