/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useRef, type JSX } from "react";
import ReactDOM from "react-dom";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import { useClickOutside, useEscapeKey, stopBubble } from "../../../hooks/useMenuDismiss";

interface NexusParticipantContextMenuProps {
    member: RoomMember;
    left: number;
    top: number;
    onFinished: () => void;
}

/**
 * Context menu with a volume slider for a remote VC participant.
 *
 * Uses an **uncontrolled** range input (defaultValue + ref) to avoid
 * React re-renders during drag, which causes Firefox to lose focus to
 * RovingTabIndex-managed elements in the room list sidebar.
 */
export const NexusParticipantContextMenu = React.memo(function NexusParticipantContextMenu({
    member,
    left,
    top,
    onFinished,
}: NexusParticipantContextMenuProps): JSX.Element {
    const conn = NexusVoiceStore.instance.getActiveConnection();
    const initialVolume = conn?.getParticipantVolume(member.userId) ?? 1;
    const volumeRef = useRef(initialVolume);
    const percentRef = useRef<HTMLSpanElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useClickOutside(menuRef, onFinished);
    useEscapeKey(onFinished);

    const onVolumeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = parseFloat(e.target.value);
            volumeRef.current = val;
            if (percentRef.current) {
                percentRef.current.textContent = `${Math.round(val * 100)}%`;
            }
            conn?.setParticipantVolume(member.userId, val);
        },
        [conn, member.userId],
    );

    return ReactDOM.createPortal(
        <div
            className="nx_ParticipantContextMenu"
            ref={menuRef}
            style={{ left, top, position: "fixed", zIndex: 5000 }}
            onPointerDown={stopBubble}
            onMouseDown={stopBubble}
            onFocusCapture={stopBubble}
        >
            <div className="nx_ParticipantContextMenu_label">
                {member.name} の音量
            </div>
            <div className="nx_ParticipantContextMenu_sliderRow">
                <input
                    type="range"
                    className="nx_ParticipantContextMenu_slider"
                    min="0"
                    max="4"
                    step="0.01"
                    defaultValue={initialVolume}
                    onChange={onVolumeChange}
                />
                <span className="nx_ParticipantContextMenu_percent" ref={percentRef}>
                    {Math.round(initialVolume * 100)}%
                </span>
            </div>
        </div>,
        document.body,
    );
});
