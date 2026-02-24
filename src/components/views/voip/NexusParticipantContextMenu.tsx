/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState, useCallback, type JSX } from "react";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import ContextMenu, { ChevronFace } from "../../structures/ContextMenu";
import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import type { ScreenShareInfo } from "../../../models/Call";

interface NexusParticipantContextMenuProps {
    member: RoomMember;
    left: number;
    top: number;
    onFinished: () => void;
}

/**
 * Context menu with a volume slider for a remote VC participant.
 */
export function NexusParticipantContextMenu({
    member,
    left,
    top,
    onFinished,
}: NexusParticipantContextMenuProps): JSX.Element {
    const conn = NexusVoiceStore.instance.getActiveConnection();
    const initialVolume = conn?.getParticipantVolume(member.userId) ?? 1;
    const [volume, setVolume] = useState(initialVolume);

    const onVolumeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = parseFloat(e.target.value);
            setVolume(val);
            conn?.setParticipantVolume(member.userId, val);
        },
        [conn, member.userId],
    );

    return (
        <ContextMenu
            chevronFace={ChevronFace.None}
            left={left}
            top={top}
            onFinished={onFinished}
            managed={false}
        >
            <div className="nx_ParticipantContextMenu">
                <div className="nx_ParticipantContextMenu_label">
                    {member.name} の音量
                </div>
                <div className="nx_ParticipantContextMenu_sliderRow">
                    <input
                        type="range"
                        className="nx_ParticipantContextMenu_slider"
                        min="0"
                        max="1"
                        step="0.01"
                        value={volume}
                        onChange={onVolumeChange}
                        onPointerDown={(e) => (e.target as HTMLElement).setPointerCapture(e.pointerId)}
                    />
                    <span className="nx_ParticipantContextMenu_percent">
                        {Math.round(volume * 100)}%
                    </span>
                </div>
            </div>
        </ContextMenu>
    );
}

// ─── Screen share context menu ──────────────────────────────

interface NexusScreenShareContextMenuProps {
    share: ScreenShareInfo;
    left: number;
    top: number;
    onFinished: () => void;
}

/**
 * Context menu with a volume slider for a remote screen share's audio.
 */
export function NexusScreenShareContextMenu({
    share,
    left,
    top,
    onFinished,
}: NexusScreenShareContextMenuProps): JSX.Element {
    const conn = NexusVoiceStore.instance.getActiveConnection();
    const initialVolume = conn?.getScreenShareVolume(share.participantIdentity) ?? 1;
    const [volume, setVolume] = useState(initialVolume);

    const onVolumeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = parseFloat(e.target.value);
            setVolume(val);
            conn?.setScreenShareVolume(share.participantIdentity, val);
        },
        [conn, share.participantIdentity],
    );

    return (
        <ContextMenu
            chevronFace={ChevronFace.None}
            left={left}
            top={top}
            onFinished={onFinished}
            managed={false}
        >
            <div className="nx_ParticipantContextMenu">
                <div className="nx_ParticipantContextMenu_label">
                    {share.participantName} の配信音量
                </div>
                <div className="nx_ParticipantContextMenu_sliderRow">
                    <input
                        type="range"
                        className="nx_ParticipantContextMenu_slider"
                        min="0"
                        max="1"
                        step="0.01"
                        value={volume}
                        onChange={onVolumeChange}
                        onPointerDown={(e) => (e.target as HTMLElement).setPointerCapture(e.pointerId)}
                    />
                    <span className="nx_ParticipantContextMenu_percent">
                        {Math.round(volume * 100)}%
                    </span>
                </div>
            </div>
        </ContextMenu>
    );
}
