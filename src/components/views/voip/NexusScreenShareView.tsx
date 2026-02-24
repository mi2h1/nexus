/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useRef, useEffect, useState, useCallback } from "react";

import { useNexusScreenShares } from "../../../hooks/useNexusScreenShares";
import type { ScreenShareInfo } from "../../../models/Call";
import { NexusScreenShareContextMenu } from "./NexusParticipantContextMenu";

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
}

/**
 * Individual screen share tile — attaches LiveKit track to <video>.
 * Audio is routed through Web Audio API (NexusVoiceConnection), not <audio>.
 */
export const ScreenShareTile: React.FC<ScreenShareTileProps> = ({ share, onStopWatching }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [contextMenu, setContextMenu] = useState<{ left: number; top: number } | null>(null);

    useEffect(() => {
        const videoEl = videoRef.current;
        if (!videoEl || !share.track) return;
        share.track.attach(videoEl);
        return () => {
            share.track.detach(videoEl);
        };
    }, [share.track]);

    const onContextMenu = useCallback((e: React.MouseEvent) => {
        // Only show context menu for remote screen shares with audio
        if (share.isLocal || !share.audioTrack) return;
        e.preventDefault();
        setContextMenu({ left: e.clientX, top: e.clientY });
    }, [share.isLocal, share.audioTrack]);

    const label = `${share.participantName}の画面`;

    return (
        <div className="mx_NexusScreenShareTile" onContextMenu={onContextMenu}>
            <video
                ref={videoRef}
                className="mx_NexusScreenShareTile_video"
                autoPlay
                playsInline
                muted
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
            {contextMenu && (
                <NexusScreenShareContextMenu
                    share={share}
                    left={contextMenu.left}
                    top={contextMenu.top}
                    onFinished={() => setContextMenu(null)}
                />
            )}
        </div>
    );
};

export default NexusScreenShareView;
