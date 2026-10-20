fn main() {
    // Autogenerates the `allow-<command>` / `deny-<command>` ACL permissions for our
    // custom (non-plugin) commands, in the unprefixed "app" namespace, so that
    // `capabilities/default.json` can grant them as plain `allow-<command>` strings.
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "app_env",
            "scope_allow_project_dir",
            "fs_stat_many",
            "flush_export",
            "preview_server_start",
            "preview_server_stop",
            "preview_window_open",
            "preview_window_close",
            "preview_window_close_all",
        ]),
    );

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
