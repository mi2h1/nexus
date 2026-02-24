/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

//! Native screen capture module using Windows Graphics Capture (WGC) + WASAPI.
//!
//! Provides Tauri commands:
//! - `enumerate_capture_targets` — list windows/monitors with thumbnails
//! - `start_capture` — begin capturing video frames + system audio
//! - `stop_capture` — stop the capture session

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct CaptureTarget {
    pub id: String,
    pub title: String,
    pub target_type: String, // "window" | "monitor"
    pub process_name: String,
    pub width: u32,
    pub height: u32,
    pub thumbnail: String, // base64 JPEG (empty for now)
}

// ─── Windows implementation ─────────────────────────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use super::CaptureTarget;
    use base64::Engine;
    use serde::Serialize;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use tauri::{AppHandle, Emitter};
    use windows_capture::{
        capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
        frame::Frame,
        graphics_capture_api::InternalCaptureControl,
        monitor::Monitor,
        settings::{
            ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
            MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
        },
        window::Window,
    };

    // ─── Global capture state ───────────────────────────────────────
    static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

    // CaptureControl is stored so stop_capture can halt the WGC session.
    // The type is erased to avoid complex generics — we only need stop().
    static CAPTURE_CONTROL: Mutex<Option<Box<dyn CaptureControlHandle>>> = Mutex::new(None);
    static AUDIO_STOP_FLAG: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

    /// Type-erased wrapper so we can store CaptureControl in a static.
    trait CaptureControlHandle: Send + Sync {
        fn stop_capture(&self) -> Result<(), String>;
    }

    // We need a wrapper because CaptureControl consumes self on stop.
    // Store it in an Option inside a Mutex for one-shot stop.
    // Fix E0277: T must be bounded by GraphicsCaptureApiHandler.
    struct ControlWrapper<T: GraphicsCaptureApiHandler + Send + 'static, E: Send + Sync + 'static>
    {
        inner: Mutex<Option<CaptureControl<T, E>>>,
    }

    impl<T, E> CaptureControlHandle for ControlWrapper<T, E>
    where
        T: GraphicsCaptureApiHandler<Error = E> + Send + 'static,
        E: Send + Sync + std::fmt::Debug + 'static,
    {
        fn stop_capture(&self) -> Result<(), String> {
            if let Some(ctrl) = self.inner.lock().unwrap().take() {
                ctrl.stop().map_err(|e| format!("{:?}", e))?;
            }
            Ok(())
        }
    }

    // ─── Frame event payloads ───────────────────────────────────────
    #[derive(Serialize, Clone)]
    pub struct FramePayload {
        pub data: String, // base64 JPEG
        pub width: u32,
        pub height: u32,
        pub timestamp: f64, // ms since epoch
    }

    #[derive(Serialize, Clone)]
    pub struct AudioPayload {
        pub data: Vec<f32>,   // interleaved PCM samples
        pub sample_rate: u32, // e.g. 48000
        pub channels: u16,    // e.g. 2
        pub frames: u32,      // number of audio frames
    }

    // ─── WGC capture handler ────────────────────────────────────────
    struct CaptureHandler {
        app: AppHandle,
        fps_interval_ms: u64,
        last_frame_time: Instant,
    }

    /// Flags passed through Settings → Context to the handler's `new()`.
    struct CaptureFlags {
        app: AppHandle,
        fps: u32,
    }

    impl GraphicsCaptureApiHandler for CaptureHandler {
        type Flags = CaptureFlags;
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let fps = ctx.flags.fps.max(1).min(60);
            Ok(Self {
                app: ctx.flags.app,
                fps_interval_ms: 1000 / fps as u64,
                last_frame_time: Instant::now(),
            })
        }

        fn on_frame_arrived(
            &mut self,
            frame: &mut Frame,
            _capture_control: InternalCaptureControl,
        ) -> Result<(), Self::Error> {
            // FPS throttling
            let now = Instant::now();
            let elapsed = now.duration_since(self.last_frame_time).as_millis() as u64;
            if elapsed < self.fps_interval_ms {
                return Ok(());
            }
            self.last_frame_time = now;

            let width = frame.width();
            let height = frame.height();

            // Get frame buffer
            let mut buffer = frame.buffer()?;
            let raw = buffer.as_raw_buffer();

            // Convert BGRA → RGB for turbojpeg
            let pixel_count = (width * height) as usize;
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            for i in 0..pixel_count {
                let offset = i * 4;
                if offset + 2 < raw.len() {
                    rgb.push(raw[offset + 2]); // R (BGRA → R)
                    rgb.push(raw[offset + 1]); // G
                    rgb.push(raw[offset]);     // B
                }
            }

            // JPEG encode (quality 90 — good balance of quality vs size)
            // Fix E0308: turbojpeg::compress expects Image<&[u8]>, use rgb.as_slice()
            let image = turbojpeg::Image {
                pixels: rgb.as_slice(),
                width: width as usize,
                pitch: width as usize * 3,
                height: height as usize,
                format: turbojpeg::PixelFormat::RGB,
            };
            let jpeg_data = turbojpeg::compress(image, 90, turbojpeg::Subsamp::Sub2x2)?;

            let payload = FramePayload {
                data: base64::engine::general_purpose::STANDARD.encode(&*jpeg_data),
                width,
                height,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
                    * 1000.0,
            };
            let _ = self.app.emit("capture-frame", &payload);

            Ok(())
        }

        fn on_closed(&mut self) -> Result<(), Self::Error> {
            CAPTURE_RUNNING.store(false, Ordering::SeqCst);
            let _ = self.app.emit("capture-stopped", ());
            Ok(())
        }
    }

    // ─── Enumerate targets ──────────────────────────────────────────
    #[tauri::command]
    pub async fn enumerate_capture_targets() -> Result<Vec<CaptureTarget>, String> {
        // Run on a blocking thread because Win32 API calls are involved
        tauri::async_runtime::spawn_blocking(|| {
            let mut targets = Vec::new();

            // Enumerate windows
            if let Ok(windows) = Window::enumerate() {
                for win in windows {
                    let title = win.title().unwrap_or_default();
                    if title.is_empty() || title == "Program Manager" {
                        continue;
                    }

                    let process_name = win.process_name().unwrap_or_default();

                    // Skip our own window
                    if process_name.to_lowercase().contains("nexus") {
                        continue;
                    }

                    let hwnd_val = win.as_raw_hwnd() as isize;
                    targets.push(CaptureTarget {
                        id: format!("window:{}", hwnd_val),
                        title,
                        target_type: "window".to_string(),
                        process_name,
                        width: 0,
                        height: 0,
                        thumbnail: String::new(),
                    });
                }
            }

            // Enumerate monitors
            if let Ok(monitors) = Monitor::enumerate() {
                for (i, mon) in monitors.iter().enumerate() {
                    let name = mon
                        .device_name()
                        .unwrap_or_else(|_| format!("ディスプレイ {}", i + 1));
                    let w = mon.width().unwrap_or(0);
                    let h = mon.height().unwrap_or(0);

                    targets.push(CaptureTarget {
                        id: format!("monitor:{}", i),
                        title: format!("画面 {} ({})", i + 1, name),
                        target_type: "monitor".to_string(),
                        process_name: String::new(),
                        width: w,
                        height: h,
                        thumbnail: String::new(),
                    });
                }
            }

            Ok(targets)
        })
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
    }

    // ─── Start capture ──────────────────────────────────────────────
    #[tauri::command]
    pub async fn start_capture(
        app: AppHandle,
        target_id: String,
        fps: u32,
        capture_audio: bool,
    ) -> Result<(), String> {
        if CAPTURE_RUNNING.load(Ordering::SeqCst) {
            return Err("Capture already running".into());
        }

        let fps = fps.max(1).min(60);

        // Parse target_id: "window:{hwnd}" or "monitor:{index}"
        let parts: Vec<&str> = target_id.splitn(2, ':').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid target_id: {}", target_id));
        }

        let capture_app = app.clone();
        let target_type = parts[0].to_string();
        let target_value = parts[1].to_string();

        // Start capture on a blocking thread
        let control: Box<dyn CaptureControlHandle> =
            tauri::async_runtime::spawn_blocking(move || -> Result<Box<dyn CaptureControlHandle>, String> {
                let flags = CaptureFlags {
                    app: capture_app,
                    fps,
                };

                match target_type.as_str() {
                    "window" => {
                        let hwnd_val: isize = target_value
                            .parse()
                            .map_err(|e| format!("Invalid HWND: {}", e))?;

                        let windows =
                            Window::enumerate().map_err(|e| format!("enumerate: {}", e))?;
                        let target_window = windows
                            .into_iter()
                            .find(|w| w.as_raw_hwnd() as isize == hwnd_val)
                            .ok_or_else(|| "Window not found".to_string())?;

                        let settings = Settings::new(
                            target_window,
                            CursorCaptureSettings::WithCursor,
                            DrawBorderSettings::WithoutBorder,
                            SecondaryWindowSettings::Default,
                            MinimumUpdateIntervalSettings::Default,
                            DirtyRegionSettings::Default,
                            ColorFormat::Bgra8,
                            flags,
                        );

                        let control = CaptureHandler::start_free_threaded(settings)
                            .map_err(|e| format!("start capture: {:?}", e))?;

                        let wrapper: Box<dyn CaptureControlHandle> = Box::new(ControlWrapper {
                            inner: Mutex::new(Some(control)),
                        });
                        Ok(wrapper)
                    }
                    "monitor" => {
                        let index: usize = target_value
                            .parse()
                            .map_err(|e| format!("Invalid index: {}", e))?;

                        let monitors =
                            Monitor::enumerate().map_err(|e| format!("enumerate: {}", e))?;
                        let target_monitor = monitors
                            .into_iter()
                            .nth(index)
                            .ok_or_else(|| "Monitor not found".to_string())?;

                        let settings = Settings::new(
                            target_monitor,
                            CursorCaptureSettings::WithCursor,
                            DrawBorderSettings::WithoutBorder,
                            SecondaryWindowSettings::Default,
                            MinimumUpdateIntervalSettings::Default,
                            DirtyRegionSettings::Default,
                            ColorFormat::Bgra8,
                            flags,
                        );

                        let control = CaptureHandler::start_free_threaded(settings)
                            .map_err(|e| format!("start capture: {:?}", e))?;

                        let wrapper: Box<dyn CaptureControlHandle> = Box::new(ControlWrapper {
                            inner: Mutex::new(Some(control)),
                        });
                        Ok(wrapper)
                    }
                    _ => Err(format!("Unknown target type: {}", target_type)),
                }
            })
            .await
            .map_err(|e| format!("spawn_blocking: {}", e))??;

        CAPTURE_RUNNING.store(true, Ordering::SeqCst);
        *CAPTURE_CONTROL.lock().unwrap() = Some(control);

        // Start WASAPI audio loopback if requested
        if capture_audio {
            let audio_app = app.clone();
            let stop_flag = Arc::new(AtomicBool::new(false));
            *AUDIO_STOP_FLAG.lock().unwrap() = Some(stop_flag.clone());

            std::thread::spawn(move || {
                if let Err(e) = run_wasapi_loopback(audio_app, stop_flag) {
                    eprintln!("WASAPI loopback error: {}", e);
                }
            });
        }

        Ok(())
    }

    // ─── Stop capture ───────────────────────────────────────────────
    #[tauri::command]
    pub async fn stop_capture() -> Result<(), String> {
        CAPTURE_RUNNING.store(false, Ordering::SeqCst);

        // Stop audio loopback
        if let Some(flag) = AUDIO_STOP_FLAG.lock().unwrap().take() {
            flag.store(true, Ordering::SeqCst);
        }

        // Stop WGC capture
        if let Some(control) = CAPTURE_CONTROL.lock().unwrap().take() {
            control.stop_capture()?;
        }

        Ok(())
    }

    // ─── WASAPI loopback capture ────────────────────────────────────
    fn run_wasapi_loopback(app: AppHandle, stop_flag: Arc<AtomicBool>) -> Result<(), String> {
        use wasapi::*;

        // Initialize COM for this thread (returns HRESULT, ignore it — panics on failure)
        initialize_mta();

        // Get default render (output) device for loopback via DeviceEnumerator
        let enumerator =
            DeviceEnumerator::new().map_err(|e| format!("DeviceEnumerator: {}", e))?;
        let device = enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| format!("get device: {}", e))?;

        let mut audio_client = device
            .get_iaudioclient()
            .map_err(|e| format!("get client: {}", e))?;

        let format = audio_client
            .get_mixformat()
            .map_err(|e| format!("get format: {}", e))?;

        let sample_rate = format.get_samplespersec();
        let channels = format.get_nchannels();
        let bytes_per_sample = (format.get_bitspersample() / 8) as usize;

        // Initialize in event-driven shared mode for loopback
        // Use Render device + Capture direction = system audio loopback
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0, // default buffer
        };
        audio_client
            .initialize_client(&format, &Direction::Capture, &mode)
            .map_err(|e| format!("init client: {}", e))?;

        let capture_client = audio_client
            .get_audiocaptureclient()
            .map_err(|e| format!("get capture client: {}", e))?;

        let event = audio_client
            .set_get_eventhandle()
            .map_err(|e| format!("set event: {}", e))?;

        audio_client
            .start_stream()
            .map_err(|e| format!("start stream: {}", e))?;

        // Audio capture loop — runs until stop_flag is set
        let mut sample_queue: VecDeque<u8> = VecDeque::new();

        while !stop_flag.load(Ordering::SeqCst) {
            // Wait for audio data (timeout 100ms to check stop_flag)
            if event.wait_for_event(100).is_err() {
                continue;
            }

            // Read raw bytes into deque
            match capture_client.read_from_device_to_deque(&mut sample_queue) {
                Ok(_buffer_info) => {
                    if sample_queue.is_empty() {
                        continue;
                    }

                    // Convert raw bytes to f32 interleaved samples
                    let total_bytes = sample_queue.len();
                    let sample_count = total_bytes / bytes_per_sample;
                    let frame_count = sample_count / channels as usize;

                    if frame_count == 0 {
                        continue;
                    }

                    let mut interleaved = Vec::with_capacity(sample_count);
                    for _ in 0..sample_count {
                        if sample_queue.len() >= bytes_per_sample {
                            if bytes_per_sample == 4 {
                                // 32-bit float
                                let b0 = sample_queue.pop_front().unwrap();
                                let b1 = sample_queue.pop_front().unwrap();
                                let b2 = sample_queue.pop_front().unwrap();
                                let b3 = sample_queue.pop_front().unwrap();
                                interleaved.push(f32::from_le_bytes([b0, b1, b2, b3]));
                            } else if bytes_per_sample == 2 {
                                // 16-bit int → f32
                                let b0 = sample_queue.pop_front().unwrap();
                                let b1 = sample_queue.pop_front().unwrap();
                                let i16_val = i16::from_le_bytes([b0, b1]);
                                interleaved.push(i16_val as f32 / 32768.0);
                            } else {
                                // Skip unknown format
                                for _ in 0..bytes_per_sample {
                                    sample_queue.pop_front();
                                }
                                interleaved.push(0.0);
                            }
                        }
                    }

                    let payload = AudioPayload {
                        data: interleaved,
                        sample_rate,
                        channels,
                        frames: frame_count as u32,
                    };
                    let _ = app.emit("capture-audio", &payload);
                }
                Err(_) => {
                    // Buffer underrun or device change — continue
                    continue;
                }
            }
        }

        audio_client
            .stop_stream()
            .map_err(|e| format!("stop stream: {}", e))?;

        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub use platform::*;

// ─── Stub implementations for non-Windows ───────────────────────────
#[cfg(not(target_os = "windows"))]
mod stub {
    use super::CaptureTarget;

    #[tauri::command]
    pub async fn enumerate_capture_targets() -> Result<Vec<CaptureTarget>, String> {
        Err("Native capture is only supported on Windows".into())
    }

    #[tauri::command]
    pub async fn start_capture(
        _app: tauri::AppHandle,
        _target_id: String,
        _fps: u32,
        _capture_audio: bool,
    ) -> Result<(), String> {
        Err("Native capture is only supported on Windows".into())
    }

    #[tauri::command]
    pub async fn stop_capture() -> Result<(), String> {
        Err("Native capture is only supported on Windows".into())
    }
}

#[cfg(not(target_os = "windows"))]
pub use stub::*;
