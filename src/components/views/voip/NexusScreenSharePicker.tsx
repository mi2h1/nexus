/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect, useRef, useState, type JSX } from "react";
import ReactDOM from "react-dom";
import classNames from "classnames";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";

const logger = rootLogger.getChild("NexusScreenSharePicker");

/** Matches the Rust CaptureTarget struct from capture.rs */
interface CaptureTarget {
    id: string;
    title: string;
    target_type: "window" | "monitor";
    process_name: string;
    width: number;
    height: number;
    thumbnail: string; // base64 JPEG (may be empty)
}

/** Tab type for the picker */
type PickerTab = "window" | "monitor";

interface NexusScreenSharePickerProps {
    /** Called when user selects a target and clicks "共有を開始" / "変更" */
    onSelect: (targetId: string, fps: number, captureAudio: boolean) => void;
    /** Called when user cancels */
    onCancel: () => void;
    /** Default FPS from screen share quality preset */
    defaultFps: number;
    /** "start" = new share, "switch" = change target during active share */
    mode?: "start" | "switch";
    /** Called when user clicks "共有を停止" (switch mode only) */
    onStop?: () => void;
}

/**
 * Discord-style screen share picker for Tauri native capture.
 * Shows a modal with tabs for "画面" (monitors) and "ウィンドウ" (windows),
 * each displaying selectable thumbnails.
 */
export const NexusScreenSharePicker = React.memo(function NexusScreenSharePicker({
    onSelect,
    onCancel,
    defaultFps,
    mode = "start",
    onStop,
}: NexusScreenSharePickerProps): JSX.Element {
    const overlayRef = useRef<HTMLDivElement>(null);
    const [targets, setTargets] = useState<CaptureTarget[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<PickerTab>("monitor");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [captureAudio, setCaptureAudio] = useState(true);

    // Fetch targets on mount
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import("@tauri-apps/api/core");
                const result = await invoke<CaptureTarget[]>("enumerate_capture_targets");
                if (!cancelled) {
                    setTargets(result);
                    // Auto-select first monitor if available
                    const firstMonitor = result.find((t) => t.target_type === "monitor");
                    if (firstMonitor) setSelectedId(firstMonitor.id);
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
        const handler = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onCancel();
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [onCancel]);

    // Close on overlay click
    const onOverlayClick = useCallback(
        (e: React.MouseEvent) => {
            if (e.target === overlayRef.current) onCancel();
        },
        [onCancel],
    );

    const onStart = useCallback(() => {
        if (!selectedId) return;
        onSelect(selectedId, defaultFps, captureAudio);
    }, [selectedId, defaultFps, captureAudio, onSelect]);

    const windows = targets.filter((t) => t.target_type === "window");
    const monitors = targets.filter((t) => t.target_type === "monitor");
    const visibleTargets = activeTab === "window" ? windows : monitors;

    const isSwitch = mode === "switch";

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
                            "nx_ScreenSharePicker_tab--active": activeTab === "monitor",
                        })}
                        onClick={() => {
                            setActiveTab("monitor");
                            const first = monitors[0];
                            setSelectedId(first ? first.id : null);
                        }}
                    >
                        画面
                        {!loading && <span className="nx_ScreenSharePicker_tabCount">{monitors.length}</span>}
                    </button>
                    <button
                        className={classNames("nx_ScreenSharePicker_tab", {
                            "nx_ScreenSharePicker_tab--active": activeTab === "window",
                        })}
                        onClick={() => {
                            setActiveTab("window");
                            setSelectedId(null);
                        }}
                    >
                        ウィンドウ
                        {!loading && <span className="nx_ScreenSharePicker_tabCount">{windows.length}</span>}
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
                                        onSelect(target.id, defaultFps, captureAudio);
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

                {/* Footer */}
                <div className="nx_ScreenSharePicker_footer">
                    {!isSwitch && (
                        <label className="nx_ScreenSharePicker_audioToggle">
                            <input
                                type="checkbox"
                                checked={captureAudio}
                                onChange={(e) => setCaptureAudio(e.target.checked)}
                            />
                            <span>音声も共有する</span>
                        </label>
                    )}
                    <div className="nx_ScreenSharePicker_actions">
                        {isSwitch && onStop && (
                            <button
                                className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--danger"
                                onClick={onStop}
                            >
                                共有を停止
                            </button>
                        )}
                        <button
                            className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--cancel"
                            onClick={onCancel}
                        >
                            キャンセル
                        </button>
                        <button
                            className="nx_ScreenSharePicker_button nx_ScreenSharePicker_button--primary"
                            onClick={onStart}
                            disabled={!selectedId}
                        >
                            {isSwitch ? "変更" : "共有を開始"}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
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
