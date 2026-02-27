mod capture;

use std::sync::atomic::{AtomicU32, Ordering};

static POPUP_COUNTER: AtomicU32 = AtomicU32::new(0);

#[tauri::command]
async fn set_popout_always_on_top(
    app: tauri::AppHandle,
    label: String,
    enabled: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;
    win.set_always_on_top(enabled)
        .map_err(|e| e.to_string())?;
    Ok(())
}

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
            set_popout_always_on_top,
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
                    let n = POPUP_COUNTER.fetch_add(1, Ordering::Relaxed);
                    let label = format!("popup-{}", n);

                    let mut builder = WebviewWindowBuilder::new(
                        &app_handle,
                        &label,
                        WebviewUrl::External(url),
                    )
                    .title("Nexus VC")
                    .always_on_top(true);

                    if let Some(size) = features.size() {
                        builder = builder.inner_size(size.width, size.height);
                    } else {
                        builder = builder.inner_size(480.0, 640.0);
                    }

                    if let Some(pos) = features.position() {
                        builder = builder.position(pos.x, pos.y);
                    }

                    match builder.build() {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(_) => NewWindowResponse::Deny,
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}
