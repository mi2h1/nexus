/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

//! Windows audio auto-ducking suppression.
//!
//! Windows lowers the volume of other applications ("ducks" them) when it
//! detects a voice-communication stream (e.g. getUserMedia). This module opts
//! every current audio session out of that behaviour by calling
//! `IAudioSessionControl2::SetDuckingPreference(true)`.
//!
//! Called once when a VC connection starts. Sessions created after that call
//! are not covered, but in practice the WebView2 audio session is created
//! before LiveKit media starts flowing, so timing is fine.

#[cfg(target_os = "windows")]
mod platform {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionEnumerator,
        IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    use windows::core::Interface;

    pub fn disable_ducking() {
        unsafe {
            if let Err(e) = do_disable() {
                eprintln!("audio_duck: disable_ducking failed: {e:?}");
            }
        }
    }

    unsafe fn do_disable() -> windows::core::Result<()> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let session_enum: IAudioSessionEnumerator = manager.GetSessionEnumerator()?;
        let count = session_enum.GetCount()?;

        for i in 0..count {
            if let Ok(control) = session_enum.GetSession(i) {
                if let Ok(control2) = control.cast::<IAudioSessionControl2>() {
                    // TRUE = opt this session out of the communications ducking experience.
                    // This prevents getUserMedia from causing Windows to lower other apps.
                    let _ = control2.SetDuckingPreference(true);
                }
            }
        }

        Ok(())
    }
}

/// Opt all current audio sessions out of Windows communications auto-ducking.
/// No-op on non-Windows platforms.
pub fn disable_ducking() {
    #[cfg(target_os = "windows")]
    platform::disable_ducking();
}
