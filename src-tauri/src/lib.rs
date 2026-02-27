mod capture;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            capture::enumerate_capture_targets,
            capture::start_capture,
            capture::stop_capture,
            capture::switch_capture_target,
        ])
        .setup(|app| {
            use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
            use tauri::WebviewUrl;

            let app_handle = app.handle().clone();

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Nexus")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .on_new_window(move |url, features| {
                    match WebviewWindowBuilder::new(
                        &app_handle,
                        "vc-popout",
                        WebviewUrl::External("about:blank".parse().unwrap()),
                    )
                    .window_features(features)
                    .title(url.as_str())
                    .on_document_title_changed(|window, title| {
                        let _ = window.set_title(&title);
                    })
                    .build()
                    {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(e) => {
                            eprintln!("Failed to create popup window: {e}");
                            NewWindowResponse::Allow
                        }
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}
