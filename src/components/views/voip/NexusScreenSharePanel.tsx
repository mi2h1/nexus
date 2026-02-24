/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect, useRef, useState, type JSX } from "react";
import ReactDOM from "react-dom";

import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import {
    SCREEN_SHARE_PRESETS,
    type ScreenShareQuality,
} from "../../../models/NexusVoiceConnection";
import AccessibleButton from "../elements/AccessibleButton";

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
 * - Sharing → change preset + "画質を変更" / "共有を停止"
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

    useClickOutside(panelRef, onFinished);
    useEscapeKey(onFinished);

    const onStartShare = useCallback(async () => {
        SettingsStore.setValue("nexus_screen_share_quality", null, SettingLevel.DEVICE, selected);
        const conn = NexusVoiceStore.instance.getActiveConnection();
        if (conn) {
            await conn.startScreenShare();
        }
        onFinished();
    }, [selected, onFinished]);

    const onChangeQuality = useCallback(async () => {
        SettingsStore.setValue("nexus_screen_share_quality", null, SettingLevel.DEVICE, selected);
        const conn = NexusVoiceStore.instance.getActiveConnection();
        if (conn) {
            await conn.republishScreenShare();
        }
        onFinished();
    }, [selected, onFinished]);

    const onStopShare = useCallback(async () => {
        const conn = NexusVoiceStore.instance.getActiveConnection();
        if (conn) {
            await conn.stopScreenShare();
        }
        onFinished();
    }, [onFinished]);

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

            <div className="nx_ScreenSharePanel_actions">
                {isScreenSharing ? (
                    <>
                        <AccessibleButton
                            className="nx_ScreenSharePanel_button nx_ScreenSharePanel_button--primary"
                            onClick={onChangeQuality}
                            disabled={selected === currentKey}
                        >
                            画質を変更
                        </AccessibleButton>
                        <AccessibleButton
                            className="nx_ScreenSharePanel_button nx_ScreenSharePanel_button--danger"
                            onClick={onStopShare}
                        >
                            共有を停止
                        </AccessibleButton>
                    </>
                ) : (
                    <AccessibleButton
                        className="nx_ScreenSharePanel_button nx_ScreenSharePanel_button--primary"
                        onClick={onStartShare}
                    >
                        共有を開始
                    </AccessibleButton>
                )}
            </div>
        </div>,
        document.body,
    );
});
