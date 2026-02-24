/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useRef, useEffect, useCallback } from "react";

import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { type ViewRoomPayload } from "../../../dispatcher/payloads/ViewRoomPayload";
import type { ScreenShareInfo } from "../../../models/Call";

interface NexusScreenSharePipProps {
    share: ScreenShareInfo;
    vcRoomId: string;
    onStartMoving: (event: React.MouseEvent) => void;
    onStopWatching: () => void;
}

/**
 * Picture-in-Picture component for screen shares.
 * Shown when the user is watching a remote screen share but has
 * navigated away from the VC room.
 */
export const NexusScreenSharePip: React.FC<NexusScreenSharePipProps> = ({
    share,
    vcRoomId,
    onStartMoving,
    onStopWatching,
}) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const videoEl = videoRef.current;
        if (!videoEl || !share.track) return;
        share.track.attach(videoEl);
        return () => {
            share.track.detach(videoEl);
        };
    }, [share.track]);

    const onClick = useCallback(() => {
        dis.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: vcRoomId,
            metricsTrigger: "WebFloatingCallWindow",
        });
    }, [vcRoomId]);

    const onStopClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            onStopWatching();
        },
        [onStopWatching],
    );

    const label = `${share.participantName}の画面`;

    return (
        <div className="mx_NexusScreenSharePip" onMouseDown={onStartMoving} onClick={onClick}>
            <video
                ref={videoRef}
                className="mx_NexusScreenSharePip_video"
                autoPlay
                playsInline
                muted
            />
            <div className="mx_NexusScreenSharePip_label">{label}</div>
            <button
                className="mx_NexusScreenSharePip_closeButton"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={onStopClick}
                aria-label="視聴を停止"
            >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                    <path d="M1.7 0.3a1 1 0 0 0-1.4 1.4L4.6 6 0.3 10.3a1 1 0 1 0 1.4 1.4L6 7.4l4.3 4.3a1 1 0 0 0 1.4-1.4L7.4 6l4.3-4.3a1 1 0 0 0-1.4-1.4L6 4.6 1.7 0.3z" />
                </svg>
            </button>
        </div>
    );
};
