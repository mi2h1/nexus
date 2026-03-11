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
            use tauri::utils::config::Color;
            use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
            use tauri::tray::{TrayIconBuilder, TrayIconEvent};
            use tauri::{Manager, WebviewUrl};

            let app_handle = app.handle().clone();
            // Fallback background before JS applies the actual theme color
            let bg = Color(0x15, 0x19, 0x1E, 0xFF);

            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Nexus")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .visible(false)
                .background_color(bg)
                .on_new_window(move |url, features| {
                    match WebviewWindowBuilder::new(
                        &app_handle,
                        "vc-popout",
                        WebviewUrl::External("about:blank".parse().unwrap()),
                    )
                    .window_features(features)
                    .visible(false)
                    .background_color(bg)
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

            // Close to tray: hide window instead of quitting
            let win = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win.hide();
                }
            });

            // System tray icon: click to show/hide main window
            let tray_handle = app.handle().clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Nexus")
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(window) = tray_handle.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}
