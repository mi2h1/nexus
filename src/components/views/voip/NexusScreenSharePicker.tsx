/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect, useRef, useState, type JSX } from "react";
import ReactDOM from "react-dom";
import classNames from "classnames";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";

import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import {
    SCREEN_SHARE_PRESETS,
    type ScreenShareQuality,
} from "../../../models/NexusVoiceConnection";

const logger = rootLogger.getChild("NexusScreenSharePicker");

const PRESET_KEYS: ScreenShareQuality[] = ["low", "standard", "high", "ultra"];

/** Matches the Rust CaptureTarget struct from capture.rs */
interface CaptureTarget {
    id: string;
    title: string;
    target_type: "window" | "monitor";
    process_name: string;
    process_id: number;
    width: number;
    height: number;
    thumbnail: string; // base64 JPEG (may be empty)
}

/** Tab type for the picker */
type PickerTab = "window" | "monitor";

interface NexusScreenSharePickerProps {
    /** Called when user selects a target and confirms */
    onSelect: (targetId: string, fps: number, captureAudio: boolean, processId: number) => void;
    /** Called when user cancels */
    onCancel: () => void;
    /** "start" = new share, "switch" = change target during active share */
    mode?: "start" | "switch";
    /** Called when user clicks "共有を停止" (switch mode only) */
    onStop?: () => void;
    /** Portal target — defaults to document.body; set to popout body when in a child window. */
    portalContainer?: HTMLElement;
}

/**
 * Discord-style screen share picker for Tauri native capture.
 * Shows a modal with tabs for "アプリ" (windows) and "画面全体" (monitors),
 * each displaying selectable thumbnails.
 *
 * In "start" mode, also shows quality presets and audio toggle.
 */
export const NexusScreenSharePicker = React.memo(function NexusScreenSharePicker({
    onSelect,
    onCancel,
    mode = "start",
    onStop,
    portalContainer,
}: NexusScreenSharePickerProps): JSX.Element {
    const overlayRef = useRef<HTMLDivElement>(null);
    const [targets, setTargets] = useState<CaptureTarget[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<PickerTab>("window");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [captureAudio, setCaptureAudio] = useState(true);

    // Quality preset state (read from settings, saved on confirm)
    const currentPresetKey = (SettingsStore.getValue("nexus_screen_share_quality") ?? "standard") as ScreenShareQuality;
    const [selectedPreset, setSelectedPreset] = useState<ScreenShareQuality>(currentPresetKey);

    const isSwitch = mode === "switch";

    // Fetch targets on mount
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                const result = await invoke<CaptureTarget[]>("enumerate_capture_targets");
                if (!cancelled) {
                    setTargets(result);
                    setLoading(false);
                }
            } catch (e) {
                logger.error("Failed to enumerate capture targets", e);
                if (!cancelled) {
                    setError(String(e));
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Poll targets every 2 seconds for real-time updates
    useEffect(() => {
        const poll = async (): Promise<void> => {
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                const result = await invoke<CaptureTarget[]>("enumerate_capture_targets");
                setTargets(result);
                // Reset selectedId if the selected target no longer exists
                setSelectedId((prev) => {
                    if (prev && !result.some((t) => t.id === prev)) return null;
                    return prev;
                });
            } catch {
                // Silently ignore polling errors
            }
        };
        const id = setInterval(poll, 2000);
        return () => clearInterval(id);
    }, []);

    // Close on Escape
    useEffect(() => {
        const doc = portalContainer?.ownerDocument ?? document;
        const handler = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onCancel();
        };
        doc.addEventListener("keydown", handler);
        return () => doc.removeEventListener("keydown", handler);
    }, [onCancel, portalContainer]);

    // Close on overlay click
    const onOverlayClick = useCallback(
        (e: React.MouseEvent) => {
            if (e.target === overlayRef.current) onCancel();
        },
        [onCancel],
    );

    /** Confirm selection — saves preset (start mode) and calls onSelect. */
    const onConfirm = useCallback(
        (overrideTargetId?: string) => {
            const id = overrideTargetId ?? selectedId;
            if (!id) return;
            const preset = SCREEN_SHARE_PRESETS[selectedPreset];
            if (!isSwitch) {
                SettingsStore.setValue("nexus_screen_share_quality", null, SettingLevel.DEVICE, selectedPreset);
            }
            const target = targets.find((t) => t.id === id);
            onSelect(id, preset.fps, captureAudio, target?.process_id ?? 0);
        },
        [selectedId, selectedPreset, captureAudio, onSelect, isSwitch, targets],
    );

    const windows = targets.filter((t) => t.target_type === "window");
    const monitors = targets.filter((t) => t.target_type === "monitor");
    const visibleTargets = activeTab === "window" ? windows : monitors;

    return ReactDOM.createPortal(
        <div className="nx_ScreenSharePicker_overlay" ref={overlayRef} onClick={onOverlayClick}>
            <div className="nx_ScreenSharePicker">
                {/* Header */}
                <div className="nx_ScreenSharePicker_header">
                    <h2 className="nx_ScreenSharePicker_title">
                        {isSwitch ? "共有先を変更" : "画面を共有"}
                    </h2>
                </div>

                {/* Tabs */}
                <div className="nx_ScreenSharePicker_tabs">
                    <button
                        className={classNames("nx_ScreenSharePicker_tab", {
                            "nx_ScreenSharePicker_tab--active": activeTab === "window",
                        })}
                        onClick={() => {
                            setActiveTab("window");
                            setSelectedId(null);
                        }}
                    >
                        アプリ
                        {!loading && <span className="nx_ScreenSharePicker_tabCount">{windows.length}</span>}
                    </button>
                    <button
                        className={classNames("nx_ScreenSharePicker_tab", {
                            "nx_ScreenSharePicker_tab--active": activeTab === "monitor",
                        })}
                        onClick={() => {
                            setActiveTab("monitor");
                            const first = monitors[0];
                            setSelectedId(first ? first.id : null);
                        }}
                    >
                        画面全体
                        {!loading && <span className="nx_ScreenSharePicker_tabCount">{monitors.length}</span>}
                    </button>
                </div>

                {/* Content */}
                <div className="nx_ScreenSharePicker_content">
                    {loading && (
                        <div className="nx_ScreenSharePicker_loading">
                            キャプチャ対象を取得中...
                        </div>
                    )}
                    {error && (
                        <div className="nx_ScreenSharePicker_error">
                            エラー: {error}
                        </div>
                    )}
                    {!loading && !error && visibleTargets.length === 0 && (
                        <div className="nx_ScreenSharePicker_empty">
                            {activeTab === "window"
                                ? "共有可能なウィンドウがありません"
                                : "ディスプレイが見つかりません"}
                        </div>
                    )}
                    {!loading && !error && visibleTargets.length > 0 && (
                        <div className="nx_ScreenSharePicker_grid">
                            {visibleTargets.map((target) => (
                                <button
                                    key={target.id}
                                    className={classNames("nx_ScreenSharePicker_item", {
                                        "nx_ScreenSharePicker_item--selected": selectedId === target.id,
                                    })}
                                    onClick={() => setSelectedId(target.id)}
                                    onDoubleClick={() => {
                                        setSelectedId(target.id);
                                        onConfirm(target.id);
                                    }}
                                >
                                    <div className="nx_ScreenSharePicker_thumbnail">
                                        {target.thumbnail ? (
                                            <img
                                                src={`data:image/jpeg;base64,${target.thumbnail}`}
                                                alt={target.title}
                                            />
                                        ) : (
                                            <div className="nx_ScreenSharePicker_thumbnailPlaceholder">
                                                {target.target_type === "monitor" ? (
                                                    <MonitorIcon />
                                                ) : (
                                                    <WindowIcon />
                                                )}
                                            </div>
                                        )}
                                    </div>
                                    <div className="nx_ScreenSharePicker_itemInfo">
                                        <span className="nx_ScreenSharePicker_itemTitle">
                                            {target.title}
                                        </span>
                                        {target.process_name && (
                                            <span className="nx_ScreenSharePicker_itemProcess">
                                                {target.process_name}
                                            </span>
                                        )}
                                        {target.width > 0 && target.height > 0 && (
                                            <span className="nx_ScreenSharePicker_itemSize">
                                                {target.width} x {target.height}
                                            </span>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Quality presets — start mode only */}
                {!isSwitch && (
                    <div className="nx_ScreenSharePicker_presets">
                        {PRESET_KEYS.map((key) => {
                            const preset = SCREEN_SHARE_PRESETS[key];
                            return (
                                <button
                                    key={key}
                                    className={classNames("nx_ScreenSharePicker_preset", {
                                        "nx_ScreenSharePicker_preset--selected": selectedPreset === key,
                                    })}
                                    onClick={() => setSelectedPreset(key)}
                                >
                                    <span className="nx_ScreenSharePicker_presetLabel">{preset.label}</span>
                                    <span className="nx_ScreenSharePicker_presetDesc">{preset.description}</span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Footer */}
                <div className="nx_ScreenSharePicker_footer">
                    {isSwitch ? (
                        <>
                            <div className="nx_ScreenSharePicker_actions">
                                {onStop && (
                                    <button
                                        className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--danger"
                                        onClick={onStop}
                                    >
                                        共有を停止
                                    </button>
                                )}
                                <button
                                    className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--primary"
                                    onClick={() => onConfirm()}
                                    disabled={!selectedId}
                                >
                                    変更
                                </button>
                            </div>
                            <button
                                className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--cancel"
                                onClick={onCancel}
                            >
                                キャンセル
                            </button>
                        </>
                    ) : (
                        <>
                            <label className="nx_ScreenSharePicker_audioToggle">
                                <input
                                    type="checkbox"
                                    checked={captureAudio}
                                    onChange={(e) => setCaptureAudio(e.target.checked)}
                                />
                                <span>音声も共有する</span>
                            </label>
                            <div className="nx_ScreenSharePicker_actions">
                                <button
                                    className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--cancel"
                                    onClick={onCancel}
                                >
                                    キャンセル
                                </button>
                                <button
                                    className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--primary"
                                    onClick={() => onConfirm()}
                                    disabled={!selectedId}
                                >
                                    共有を開始
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>,
        portalContainer ?? document.body,
    );
});

// ─── Simple SVG icons ──────────────────────────────────────────────────

function MonitorIcon(): JSX.Element {
    return (
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
        </svg>
    );
}

function WindowIcon(): JSX.Element {
    return (
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
            <circle cx="6" cy="6" r="0.5" fill="currentColor" />
            <circle cx="8.5" cy="6" r="0.5" fill="currentColor" />
            <circle cx="11" cy="6" r="0.5" fill="currentColor" />
        </svg>
    );
}
