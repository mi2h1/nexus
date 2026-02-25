/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect, useRef, useState, type JSX } from "react";
import ReactDOM from "react-dom";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";

import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import {
    SCREEN_SHARE_PRESETS,
    type ScreenShareQuality,
} from "../../../models/NexusVoiceConnection";
import { isTauri } from "../../../utils/tauriHttp";
import { NexusScreenSharePicker } from "./NexusScreenSharePicker";

const logger = rootLogger.getChild("NexusScreenSharePanel");

const PRESET_KEYS: ScreenShareQuality[] = ["low", "standard", "high", "ultra"];

/**
 * Close the panel when clicking/tapping outside.
 */
function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void): void {
    useEffect(() => {
        const handler = (e: PointerEvent): void => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener("pointerdown", handler);
        return () => document.removeEventListener("pointerdown", handler);
    }, [ref, onClose]);
}

/**
 * Close the panel on Escape key.
 */
function useEscapeKey(onClose: () => void): void {
    useEffect(() => {
        const handler = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [onClose]);
}

/** Stop pointer/mouse/focus events from bubbling to RovingTabIndex ancestors. */
function stopBubble(e: React.SyntheticEvent): void {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
}

interface NexusScreenSharePanelProps {
    isScreenSharing: boolean;
    anchorLeft: number;
    anchorBottom: number;
    onFinished: () => void;
}

/**
 * "Go Live" panel — quality preset selector for screen sharing.
 * Shown above the screen share button in the VC control bar.
 *
 * - Not sharing → select preset + "共有を開始"
 * - Sharing → "共有を停止"
 *
 * In Tauri mode, clicking "共有を開始" opens the native capture picker
 * (NexusScreenSharePicker) instead of the browser's getDisplayMedia.
 */
export const NexusScreenSharePanel = React.memo(function NexusScreenSharePanel({
    isScreenSharing,
    anchorLeft,
    anchorBottom,
    onFinished,
}: NexusScreenSharePanelProps): JSX.Element {
    const panelRef = useRef<HTMLDivElement>(null);
    const currentKey = (SettingsStore.getValue("nexus_screen_share_quality") ?? "standard") as ScreenShareQuality;
    const [selected, setSelected] = useState<ScreenShareQuality>(currentKey);
    const [showNativePicker, setShowNativePicker] = useState(false);

    useClickOutside(panelRef, onFinished);
    useEscapeKey(onFinished);

    const onStartShare = useCallback(() => {
        SettingsStore.setValue("nexus_screen_share_quality", null, SettingLevel.DEVICE, selected);

        if (isTauri()) {
            // Show native picker overlay (replaces this panel)
            setShowNativePicker(true);
        } else {
            // Browser: close panel FIRST, then start screen share.
            onFinished();
            const conn = NexusVoiceStore.instance.getActiveConnection();
            conn?.startScreenShare().catch((e) => logger.warn("Failed to start screen share", e));
        }
    }, [selected, onFinished]);

    const onNativePickerSelect = useCallback(
        (targetId: string, fps: number, captureAudio: boolean) => {
            setShowNativePicker(false);
            onFinished();
            const conn = NexusVoiceStore.instance.getActiveConnection();
            conn?.startNativeScreenShare(targetId, fps, captureAudio).catch((e) =>
                logger.warn("Failed to start native screen share", e),
            );
        },
        [onFinished],
    );

    const onNativePickerCancel = useCallback(() => {
        setShowNativePicker(false);
    }, []);

    const onStopShare = useCallback(() => {
        onFinished();
        const conn = NexusVoiceStore.instance.getActiveConnection();
        conn?.stopScreenShare().catch((e) => logger.warn("Failed to stop screen share", e));
    }, [onFinished]);

    // If native picker is shown, render that instead
    if (showNativePicker) {
        const preset = SCREEN_SHARE_PRESETS[selected];
        return (
            <NexusScreenSharePicker
                onSelect={onNativePickerSelect}
                onCancel={onNativePickerCancel}
                defaultFps={preset.fps}
            />
        );
    }

    return ReactDOM.createPortal(
        <div
            className="nx_ScreenSharePanel"
            ref={panelRef}
            style={{
                left: anchorLeft,
                bottom: anchorBottom,
                position: "fixed",
                zIndex: 5000,
            }}
            onPointerDown={stopBubble}
            onMouseDown={stopBubble}
            onFocusCapture={stopBubble}
        >
            <div className="nx_ScreenSharePanel_title">
                {isScreenSharing ? "配信設定" : "画面を共有"}
            </div>

            <div className="nx_ScreenSharePanel_presets">
                {PRESET_KEYS.map((key) => {
                    const preset = SCREEN_SHARE_PRESETS[key];
                    return (
                        <label key={key} className="nx_ScreenSharePanel_preset">
                            <input
                                type="radio"
                                name="nx_screenShareQuality"
                                checked={selected === key}
                                onChange={() => setSelected(key)}
                            />
                            <span className="nx_ScreenSharePanel_presetLabel">{preset.label}</span>
                            <span className="nx_ScreenSharePanel_presetDesc">{preset.description}</span>
                        </label>
                    );
                })}
            </div>

            {!isScreenSharing && !isTauri() && (
                <div className="nx_ScreenSharePanel_notice">
                    ブラウザ版では音声は共有されません
                </div>
            )}

            <div className="nx_ScreenSharePanel_actions">
                {isScreenSharing ? (
                    <button
                        className="nx_ScreenSharePanel_button nx_ScreenSharePanel_button--danger"
                        onClick={onStopShare}
                    >
                        共有を停止
                    </button>
                ) : (
                    <button
                        className="nx_ScreenSharePanel_button nx_ScreenSharePanel_button--primary"
                        onClick={onStartShare}
                    >
                        共有を開始
                    </button>
                )}
            </div>
        </div>,
        document.body,
    );
});
