/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useRef, useEffect, useState, useCallback } from "react";

import { useNexusScreenShares } from "../../../hooks/useNexusScreenShares";
import type { ScreenShareInfo } from "../../../models/Call";
import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";

interface NexusScreenShareContainerProps {
    roomId: string;
}

/**
 * Wrapper component that conditionally renders the screen share panel
 * when there are active screen shares in the room.
 */
export const NexusScreenShareContainer: React.FC<NexusScreenShareContainerProps> = ({ roomId }) => {
    const screenShares = useNexusScreenShares(roomId);

    if (screenShares.length === 0) return null;
    return <NexusScreenShareView screenShares={screenShares} />;
};

interface NexusScreenShareViewProps {
    screenShares: ScreenShareInfo[];
}

const MIN_HEIGHT = 150;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;

/**
 * Panel that displays screen share video feeds with a resize handle.
 */
const NexusScreenShareView: React.FC<NexusScreenShareViewProps> = ({ screenShares }) => {
    const [height, setHeight] = useState(DEFAULT_HEIGHT);
    const resizing = useRef(false);
    const startY = useRef(0);
    const startHeight = useRef(DEFAULT_HEIGHT);

    const onResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        resizing.current = true;
        startY.current = e.clientY;
        startHeight.current = height;

        const onMouseMove = (ev: MouseEvent): void => {
            if (!resizing.current) return;
            const delta = ev.clientY - startY.current;
            const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight.current + delta));
            setHeight(newHeight);
        };

        const onMouseUp = (): void => {
            resizing.current = false;
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    }, [height]);

    return (
        <div className="mx_NexusScreenSharePanel" style={{ height }}>
            <div className="mx_NexusScreenSharePanel_content">
                {screenShares.map((share) => (
                    <ScreenShareTile key={share.participantIdentity} share={share} />
                ))}
            </div>
            <div
                className="mx_NexusScreenSharePanel_resizeHandle"
                onMouseDown={onResizeStart}
            />
        </div>
    );
};

interface ScreenShareTileProps {
    share: ScreenShareInfo;
    onStopWatching?: () => void;
    /** Callback for right-click on a remote screen share (used by unified context menu). */
    onShareContextMenu?: (share: ScreenShareInfo, left: number, top: number) => void;
}

/** Minimum freeze duration (ms) before triggering A/V resync. */
const FREEZE_THRESHOLD_MS = 500;
/** Cooldown (ms) between consecutive resyncs to avoid flicker. */
const RESYNC_COOLDOWN_MS = 3000;

/**
 * Individual screen share tile — combines video + audio tracks into a single
 * MediaStream on the <video> element for A/V sync.
 * Volume control is handled by NexusVoiceConnection via the registered element.
 */
export const ScreenShareTile: React.FC<ScreenShareTileProps> = ({ share, onStopWatching, onShareContextMenu }) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const videoEl = videoRef.current;
        if (!videoEl || !share.track) return;

        const hasAudio = !share.isLocal && share.audioTrack?.mediaStreamTrack;

        // Build a combined MediaStream with video + audio for A/V sync.
        const buildStream = (): MediaStream => {
            const s = new MediaStream([share.track.mediaStreamTrack]);
            if (hasAudio) {
                s.addTrack(share.audioTrack.mediaStreamTrack);
            }
            return s;
        };

        videoEl.srcObject = buildStream();
        videoEl.muted = true;
        videoEl.play().catch(() => {});

        // Register with NexusVoiceConnection for volume control
        const conn = NexusVoiceStore.instance.getActiveConnection();
        if (conn && hasAudio) {
            conn.registerScreenShareVideoElement(share.participantIdentity, videoEl);
        }

        // ─── A/V resync after video freeze ─────────────────────────
        // WebRTC video can freeze on keyframe loss while audio continues.
        // After recovery the video jumps ahead, breaking sync.
        // Detect freezes via requestVideoFrameCallback: during a freeze
        // no callbacks fire, so the wall-clock gap between consecutive
        // callbacks reveals the freeze duration.
        let lastCbTime = 0;
        let lastResyncTime = 0;
        let frameCallbackId = 0;
        let cancelled = false;

        const onVideoFrame = (): void => {
            if (cancelled) return;
            const now = performance.now();

            if (
                lastCbTime > 0 &&
                now - lastCbTime > FREEZE_THRESHOLD_MS &&
                now - lastResyncTime > RESYNC_COOLDOWN_MS
            ) {
                videoEl.srcObject = buildStream();
                videoEl.play().catch(() => {});
                lastCbTime = 0;
                lastResyncTime = now;
            } else {
                lastCbTime = now;
            }

            frameCallbackId = videoEl.requestVideoFrameCallback(onVideoFrame);
        };

        if (hasAudio && "requestVideoFrameCallback" in videoEl) {
            frameCallbackId = videoEl.requestVideoFrameCallback(onVideoFrame);
        }

        return () => {
            cancelled = true;
            if (frameCallbackId && "cancelVideoFrameCallback" in videoEl) {
                (videoEl as any).cancelVideoFrameCallback(frameCallbackId);
            }
            videoEl.srcObject = null;
            if (conn && hasAudio) {
                conn.unregisterScreenShareVideoElement(share.participantIdentity);
            }
        };
    }, [share.track, share.audioTrack, share.participantIdentity, share.isLocal]);

    const onContextMenu = useCallback((e: React.MouseEvent) => {
        if (!onShareContextMenu) return;
        if (share.isLocal) return;
        e.preventDefault();
        e.stopPropagation();
        onShareContextMenu(share, e.clientX, e.clientY);
    }, [share, onShareContextMenu]);

    const label = `${share.participantName}の画面`;

    return (
        <div className="mx_NexusScreenShareTile" onContextMenu={onContextMenu}>
            <video
                ref={videoRef}
                className="mx_NexusScreenShareTile_video"
                autoPlay
                playsInline
            />
            <div className="mx_NexusScreenShareTile_label">{label}</div>
            {onStopWatching && (
                <div className="mx_NexusScreenShareTile_stopOverlay">
                    <button
                        className="mx_NexusScreenShareTile_stopButton"
                        onClick={(e) => { e.stopPropagation(); onStopWatching(); }}
                    >
                        視聴を停止
                    </button>
                </div>
            )}
        </div>
    );
};

export default NexusScreenShareView;
