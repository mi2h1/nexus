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
    // windows crate — used for process-excluded loopback (Win10 2004+)
    use windows::Win32::Media::Audio::{
        IActivateAudioInterfaceCompletionHandler,
        IActivateAudioInterfaceCompletionHandler_Impl,
        IActivateAudioInterfaceAsyncOperation,
    };
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
    use windows::Win32::Foundation::{HANDLE, TRUE, FALSE, CloseHandle};
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

            // Convert BGRA → RGB for turbojpeg.
            // WGC frame buffers may have row padding (stride > width * 4),
            // especially for window captures. Compute actual stride from buffer size.
            let expected_row_bytes = width as usize * 4;
            let stride = if height > 0 {
                raw.len() / height as usize
            } else {
                expected_row_bytes
            };

            let pixel_count = (width * height) as usize;
            let mut rgb = Vec::with_capacity(pixel_count * 3);
            for y in 0..height as usize {
                for x in 0..width as usize {
                    let offset = y * stride + x * 4;
                    if offset + 2 < raw.len() {
                        rgb.push(raw[offset + 2]); // R (BGRA → R)
                        rgb.push(raw[offset + 1]); // G
                        rgb.push(raw[offset]);     // B
                    }
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

    // ─── Shared audio helpers ────────────────────────────────────────

    /// Decode raw bytes to f32 samples.
    fn decode_samples(raw: &[u8], bytes_per_sample: usize, total_samples: usize) -> Vec<f32> {
        let mut samples = Vec::with_capacity(total_samples);
        for i in 0..total_samples {
            let offset = i * bytes_per_sample;
            if offset + bytes_per_sample > raw.len() {
                break;
            }
            let sample = if bytes_per_sample == 4 {
                f32::from_le_bytes([raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]])
            } else if bytes_per_sample == 2 {
                i16::from_le_bytes([raw[offset], raw[offset + 1]]) as f32 / 32768.0
            } else {
                0.0
            };
            samples.push(sample);
        }
        samples
    }

    /// Downmix multi-channel audio to stereo (interleaved).
    fn downmix_to_stereo(all_samples: &[f32], channels: usize, frame_count: usize) -> Vec<f32> {
        if channels == 2 {
            all_samples.to_vec()
        } else if channels == 1 {
            let mut s = Vec::with_capacity(frame_count * 2);
            for i in 0..frame_count {
                let v = all_samples.get(i).copied().unwrap_or(0.0);
                s.push(v);
                s.push(v);
            }
            s
        } else {
            // Multi-channel (5.1, 7.1, etc.) → stereo: take L (ch0) and R (ch1)
            let mut s = Vec::with_capacity(frame_count * 2);
            for f in 0..frame_count {
                let base = f * channels;
                let l = all_samples.get(base).copied().unwrap_or(0.0);
                let r = all_samples.get(base + 1).copied().unwrap_or(0.0);
                s.push(l);
                s.push(r);
            }
            s
        }
    }

    // ─── WASAPI loopback capture (entry point) ───────────────────────

    /// Try process-excluded loopback first (Win10 2004+), fall back to regular.
    fn run_wasapi_loopback(app: AppHandle, stop_flag: Arc<AtomicBool>) -> Result<(), String> {
        // Try process-excluded loopback: captures all system audio EXCEPT
        // audio from our own process (prevents voice chat echo).
        match run_process_excluded_loopback(&app, &stop_flag) {
            Ok(()) => return Ok(()),
            Err(e) => {
                println!(
                    "[WASAPI] Process-excluded loopback unavailable: {}. \
                     Falling back to regular loopback (voice echo possible).",
                    e
                );
                let _ = app.emit(
                    "wasapi-info",
                    "WASAPI: regular loopback (process exclusion unavailable)",
                );
            }
        }
        run_regular_loopback(app, stop_flag)
    }

    // ─── Process-excluded loopback (Windows 10 2004+) ────────────────
    //
    // Uses ActivateAudioInterfaceAsync with PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
    // to capture all system audio EXCEPT our own process's output.
    // This prevents voice chat audio from being captured and echoed back.

    /// Raw PROPVARIANT layout for VT_BLOB on x64.
    /// Used to pass AUDIOCLIENT_ACTIVATION_PARAMS to ActivateAudioInterfaceAsync.
    #[repr(C)]
    struct PropVariantBlob {
        vt: u16,             // VT_BLOB = 0x0041
        reserved1: u16,
        reserved2: u16,
        reserved3: u16,
        cb_size: u32,        // BLOB.cbSize
        _pad: u32,           // alignment padding on x64
        p_blob_data: *const u8, // BLOB.pBlobData
    }

    /// Activation params for process loopback.
    #[repr(C)]
    struct ProcessLoopbackActivationParams {
        activation_type: i32,        // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
        target_process_id: u32,      // our PID
        process_loopback_mode: i32,  // PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
    }

    /// COM completion handler for ActivateAudioInterfaceAsync.
    #[windows::core::implement(IActivateAudioInterfaceCompletionHandler)]
    struct ActivateCompletionHandler {
        event: isize, // HANDLE as isize (Send-safe)
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateCompletionHandler_Impl {
        fn ActivateCompleted(
            &self,
            _operation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            unsafe {
                let _ = SetEvent(HANDLE(self.event as *mut std::ffi::c_void));
            }
            Ok(())
        }
    }

    fn run_process_excluded_loopback(
        app: &AppHandle,
        stop_flag: &Arc<AtomicBool>,
    ) -> Result<(), String> {
        use windows::core::Interface;
        use windows::Win32::Media::Audio::*;
        use windows::Win32::System::Com::*;

        println!("[WASAPI] Attempting process-excluded loopback (Win10 2004+)");

        unsafe {
            // Initialize COM for this thread
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            // Build activation params: exclude our own process
            let params = ProcessLoopbackActivationParams {
                activation_type: 1,        // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
                target_process_id: std::process::id(),
                process_loopback_mode: 1,  // PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
            };

            // Wrap in a raw PROPVARIANT with VT_BLOB
            let prop = PropVariantBlob {
                vt: 0x0041, // VT_BLOB
                reserved1: 0,
                reserved2: 0,
                reserved3: 0,
                cb_size: std::mem::size_of::<ProcessLoopbackActivationParams>() as u32,
                _pad: 0,
                p_blob_data: &params as *const _ as *const u8,
            };

            // Create event for synchronous wait
            let event = CreateEventW(None, TRUE, FALSE, None)
                .map_err(|e| format!("CreateEventW: {}", e))?;

            // Create completion handler
            let handler: IActivateAudioInterfaceCompletionHandler =
                ActivateCompletionHandler {
                    event: event.0 as isize,
                }
                .into();

            // Activate the process-excluded loopback audio client
            // Cast raw PropVariantBlob to *const PROPVARIANT (same C ABI layout)
            let prop_ptr = &prop as *const PropVariantBlob as *const windows_core::PROPVARIANT;
            let operation = ActivateAudioInterfaceAsync(
                windows::core::w!("VAD\\Process_Loopback"),
                &IAudioClient::IID,
                Some(prop_ptr),
                &handler,
            )
            .map_err(|e| format!("ActivateAudioInterfaceAsync: {}", e))?;

            // Wait for completion (5 seconds)
            let _ = WaitForSingleObject(event, 5000);
            let _ = CloseHandle(event);

            // Get activation result
            let op = operation;
            let mut hr = windows::core::HRESULT(0);
            let mut unk: Option<windows::core::IUnknown> = None;
            op.GetActivateResult(&mut hr, &mut unk)
                .map_err(|e| format!("GetActivateResult: {}", e))?;
            hr.ok().map_err(|e| format!("Activation HRESULT: {}", e))?;

            let client: IAudioClient = unk
                .ok_or("No audio client returned")?
                .cast()
                .map_err(|e| format!("Cast IAudioClient: {}", e))?;

            println!("[WASAPI] Process-excluded loopback client activated (PID={} excluded)", std::process::id());

            // Process loopback virtual device does NOT support GetMixFormat.
            // Instead, specify the format directly. With AUTOCONVERTPCM flag,
            // Windows will convert from the device's native format automatically.
            // Use 48kHz stereo float32 — the standard LiveKit/WebRTC format.
            let sample_rate: u32 = 48000;
            let channels: usize = 2;
            let bits: u16 = 32;
            let bytes_per_sample: usize = 4;
            let mut format = windows::Win32::Media::Audio::WAVEFORMATEX {
                wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
                nChannels: channels as u16,
                nSamplesPerSec: sample_rate,
                nAvgBytesPerSec: sample_rate * channels as u32 * bytes_per_sample as u32,
                nBlockAlign: (channels * bytes_per_sample) as u16,
                wBitsPerSample: bits,
                cbSize: 0,
            };
            let format_ptr = &mut format as *mut windows::Win32::Media::Audio::WAVEFORMATEX;

            println!(
                "[WASAPI] Process-excluded format: {}Hz, {}ch, {}bit (specified directly)",
                sample_rate, channels, bits
            );
            let _ = app.emit(
                "wasapi-info",
                format!("WASAPI (process-excluded): {}Hz {}ch {}bit", sample_rate, channels, bits),
            );

            // Initialize client: shared mode, event-driven, auto-convert PCM
            // Note: no AUDCLNT_STREAMFLAGS_LOOPBACK needed — the virtual device
            // is already a loopback interface.
            // AUTOCONVERTPCM: Windows resamples from device native format to our format.
            let init_flags: u32 = 0x00040000   // AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | 0x80000000                    // AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | 0x08000000;                   // AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    init_flags,
                    2_000_000, // 200ms buffer (in 100ns units)
                    0,
                    format_ptr as *const _,
                    None,
                )
                .map_err(|e| format!("Initialize: {}", e))?;

            // Get capture client and set up event handle
            let capture_client: IAudioCaptureClient = client
                .GetService()
                .map_err(|e| format!("GetService(IAudioCaptureClient): {}", e))?;

            let event_handle = CreateEventW(None, FALSE, FALSE, None)
                .map_err(|e| format!("CreateEventW: {}", e))?;
            client
                .SetEventHandle(event_handle)
                .map_err(|e| format!("SetEventHandle: {}", e))?;

            // Start the stream
            client.Start().map_err(|e| format!("Start: {}", e))?;
            println!("[WASAPI] Process-excluded loopback capture started");

            // Capture loop
            let mut first_data = true;
            while !stop_flag.load(Ordering::SeqCst) {
                let wait_result = WaitForSingleObject(event_handle, 100);
                if wait_result.0 == 258 { // WAIT_TIMEOUT
                    continue;
                }

                // Read all available packets
                loop {
                    let mut buffer_ptr: *mut u8 = std::ptr::null_mut();
                    let mut frames_available: u32 = 0;
                    let mut flags: u32 = 0;

                    if capture_client
                        .GetBuffer(
                            &mut buffer_ptr,
                            &mut frames_available,
                            &mut flags,
                            None,
                            None,
                        )
                        .is_err()
                        || frames_available == 0
                    {
                        break;
                    }

                    if first_data {
                        first_data = false;
                        println!(
                            "[WASAPI] Process-excluded: first {} frames captured",
                            frames_available
                        );
                    }

                    let total_samples = frames_available as usize * channels;
                    let buffer_bytes = total_samples * bytes_per_sample;
                    let raw_data = std::slice::from_raw_parts(buffer_ptr, buffer_bytes);

                    let all_samples = decode_samples(raw_data, bytes_per_sample, total_samples);
                    let stereo =
                        downmix_to_stereo(&all_samples, channels, frames_available as usize);

                    let payload = AudioPayload {
                        data: stereo,
                        sample_rate: sample_rate,
                        channels: 2,
                        frames: frames_available,
                    };
                    let _ = app.emit("capture-audio", &payload);

                    let _ = capture_client.ReleaseBuffer(frames_available);
                }
            }

            // Stop
            let _ = client.Stop();
            let _ = CloseHandle(event_handle);

            println!("[WASAPI] Process-excluded loopback capture stopped");
            Ok(())
        }
    }

    // ─── Regular WASAPI loopback (fallback) ──────────────────────────
    //
    // Used when process-excluded loopback is unavailable (Windows < 10 2004).
    // Captures ALL system audio, including voice chat (may cause echo).

    fn run_regular_loopback(app: AppHandle, stop_flag: Arc<AtomicBool>) -> Result<(), String> {
        use wasapi::*;

        // Initialize COM for this thread
        initialize_mta();

        // Get default render (output) device for loopback
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

        let device_sample_rate = format.get_samplespersec();
        let device_channels = format.get_nchannels() as usize;
        let bytes_per_sample = (format.get_bitspersample() / 8) as usize;

        println!(
            "[WASAPI] Regular loopback format: {}Hz, {}ch, {}bit ({}B/sample)",
            device_sample_rate, device_channels, format.get_bitspersample(), bytes_per_sample
        );
        let _ = app.emit(
            "wasapi-info",
            format!(
                "WASAPI (regular): {}Hz {}ch {}bit",
                device_sample_rate, device_channels, format.get_bitspersample()
            ),
        );

        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 0,
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

        println!("[WASAPI] Regular loopback capture started");

        let mut sample_queue: VecDeque<u8> = VecDeque::new();
        let mut first_data = true;

        while !stop_flag.load(Ordering::SeqCst) {
            if event.wait_for_event(100).is_err() {
                continue;
            }

            match capture_client.read_from_device_to_deque(&mut sample_queue) {
                Ok(_buffer_info) => {
                    if sample_queue.is_empty() {
                        continue;
                    }

                    let total_bytes = sample_queue.len();
                    let total_samples = total_bytes / bytes_per_sample;
                    let frame_count = total_samples / device_channels;

                    if frame_count == 0 {
                        continue;
                    }

                    if first_data {
                        first_data = false;
                        println!(
                            "[WASAPI] First audio data: {} bytes, {} frames, {} samples",
                            total_bytes, frame_count, total_samples
                        );
                    }

                    // Decode raw bytes → f32 from the deque
                    let mut all_samples = Vec::with_capacity(total_samples);
                    for _ in 0..total_samples {
                        if sample_queue.len() >= bytes_per_sample {
                            let sample = if bytes_per_sample == 4 {
                                let b0 = sample_queue.pop_front().unwrap();
                                let b1 = sample_queue.pop_front().unwrap();
                                let b2 = sample_queue.pop_front().unwrap();
                                let b3 = sample_queue.pop_front().unwrap();
                                f32::from_le_bytes([b0, b1, b2, b3])
                            } else if bytes_per_sample == 2 {
                                let b0 = sample_queue.pop_front().unwrap();
                                let b1 = sample_queue.pop_front().unwrap();
                                i16::from_le_bytes([b0, b1]) as f32 / 32768.0
                            } else {
                                for _ in 0..bytes_per_sample {
                                    sample_queue.pop_front();
                                }
                                0.0
                            };
                            all_samples.push(sample);
                        }
                    }

                    let stereo = downmix_to_stereo(&all_samples, device_channels, frame_count);

                    let payload = AudioPayload {
                        data: stereo,
                        sample_rate: device_sample_rate,
                        channels: 2,
                        frames: frame_count as u32,
                    };
                    let _ = app.emit("capture-audio", &payload);
                }
                Err(_) => {
                    continue;
                }
            }
        }

        audio_client
            .stop_stream()
            .map_err(|e| format!("stop stream: {}", e))?;

        println!("[WASAPI] Regular loopback capture stopped");
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
