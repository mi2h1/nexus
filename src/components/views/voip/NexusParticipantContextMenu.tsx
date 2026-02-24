/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState, useCallback, useEffect, useRef, type JSX } from "react";
import ReactDOM from "react-dom";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import type { ScreenShareInfo } from "../../../models/Call";

/**
 * Close the menu when clicking/tapping outside.
 * Uses pointerdown (not mousedown) because Firefox dispatches spurious
 * mouse events from range-input drags that can close the menu.
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
 * Close the menu on Escape key.
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

interface NexusParticipantContextMenuProps {
    member: RoomMember;
    left: number;
    top: number;
    onFinished: () => void;
}

/**
 * Context menu with a volume slider for a remote VC participant.
 * Rendered via portal to avoid ContextMenu's focus/event management
 * which interferes with range input dragging in Firefox.
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
    const menuRef = useRef<HTMLDivElement>(null);

    useClickOutside(menuRef, onFinished);
    useEscapeKey(onFinished);

    const onVolumeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = parseFloat(e.target.value);
            setVolume(val);
            conn?.setParticipantVolume(member.userId, val);
        },
        [conn, member.userId],
    );

    return ReactDOM.createPortal(
        <div
            className="nx_ParticipantContextMenu"
            ref={menuRef}
            style={{ left, top, position: "fixed", zIndex: 5000 }}
        >
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
                />
                <span className="nx_ParticipantContextMenu_percent">
                    {Math.round(volume * 100)}%
                </span>
            </div>
        </div>,
        document.body,
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
    const menuRef = useRef<HTMLDivElement>(null);

    useClickOutside(menuRef, onFinished);
    useEscapeKey(onFinished);

    const onVolumeChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = parseFloat(e.target.value);
            setVolume(val);
            conn?.setScreenShareVolume(share.participantIdentity, val);
        },
        [conn, share.participantIdentity],
    );

    return ReactDOM.createPortal(
        <div
            className="nx_ParticipantContextMenu"
            ref={menuRef}
            style={{ left, top, position: "fixed", zIndex: 5000 }}
        >
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
                />
                <span className="nx_ParticipantContextMenu_percent">
                    {Math.round(volume * 100)}%
                </span>
            </div>
        </div>,
        document.body,
    );
}
