mod capture;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            capture::enumerate_capture_targets,
            capture::start_capture,
            capture::stop_capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}
