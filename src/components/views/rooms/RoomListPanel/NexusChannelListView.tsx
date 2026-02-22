/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import {
    RoomListItemView,
    RoomListLoadingSkeleton,
    RoomListEmptyStateView,
    useViewModel,
    type RoomListViewModel,
    type Room as SharedRoom,
} from "@element-hq/web-shared-components";

import { useChannelSeparation } from "../../../../hooks/useChannelSeparation";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";

export interface NexusChannelListViewProps {
    vm: RoomListViewModel;
    renderAvatar: (room: SharedRoom) => ReactNode;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Discord-style channel list with text/voice separation.
 * Replaces SharedRoomListView to display rooms in two sections:
 * 1. Text channels (all non-video rooms)
 * 2. Voice channels (video rooms / RoomType.UnstableCall)
 */
export function NexusChannelListView({ vm, renderAvatar, onKeyDown }: NexusChannelListViewProps): JSX.Element {
    const snapshot = useViewModel(vm);
    const matrixClient = useMatrixClientContext();
    const { textRoomIds, voiceRoomIds } = useChannelSeparation(snapshot.roomIds, matrixClient);
    const allRoomIds = snapshot.roomIds;
    const activeRoomIndex = snapshot.roomListState.activeRoomIndex;

    // Roving tabindex: track which room currently holds tab focus
    const [focusedRoomId, setFocusedRoomId] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [hasFocus, setHasFocus] = useState(false);

    // Register all rooms as visible on mount and when roomIds change
    // (no virtualization — small-scale usage)
    useEffect(() => {
        if (allRoomIds.length > 0) {
            vm.updateVisibleRooms(0, allRoomIds.length);
        }
    }, [allRoomIds, vm]);

    const onFocus = useCallback((roomId: string, _e: React.FocusEvent) => {
        setFocusedRoomId(roomId);
    }, []);

    const handleContainerFocus = useCallback(() => setHasFocus(true), []);
    const handleContainerBlur = useCallback(() => setHasFocus(false), []);

    // Loading state
    if (snapshot.isLoadingRooms) {
        return <RoomListLoadingSkeleton />;
    }

    // Empty state
    if (snapshot.isRoomListEmpty) {
        return <RoomListEmptyStateView vm={vm} />;
    }

    const totalRoomCount = allRoomIds.length;

    const renderRoomItem = (roomId: string, globalIndex: number): JSX.Element => {
        const roomItemVM = vm.getRoomItemViewModel(roomId);
        const isSelected = activeRoomIndex === globalIndex;
        const isFocused = hasFocus && focusedRoomId === roomId;

        return (
            <RoomListItemView
                key={roomId}
                vm={roomItemVM}
                renderAvatar={renderAvatar}
                isSelected={isSelected}
                isFocused={isFocused}
                onFocus={onFocus}
                roomIndex={globalIndex}
                roomCount={totalRoomCount}
            />
        );
    };

    // Build a global index map: roomId → index in allRoomIds
    const globalIndexMap = new Map<string, number>();
    for (let i = 0; i < allRoomIds.length; i++) {
        globalIndexMap.set(allRoomIds[i], i);
    }

    return (
        <div
            ref={containerRef}
            className="mx_NexusChannelList"
            role="listbox"
            aria-label="Channel list"
            onKeyDown={onKeyDown}
            onFocus={handleContainerFocus}
            onBlur={handleContainerBlur}
        >
            {/* Text Channels */}
            {textRoomIds.length > 0 && (
                <div className="mx_NexusChannelList_section">
                    <div className="mx_NexusChannelList_sectionHeader">TEXT CHANNELS</div>
                    {textRoomIds.map((roomId) => renderRoomItem(roomId, globalIndexMap.get(roomId) ?? 0))}
                </div>
            )}

            {/* Voice Channels */}
            {voiceRoomIds.length > 0 && (
                <div className="mx_NexusChannelList_section">
                    <div className="mx_NexusChannelList_sectionHeader">VOICE CHANNELS</div>
                    {voiceRoomIds.map((roomId) => renderRoomItem(roomId, globalIndexMap.get(roomId) ?? 0))}
                </div>
            )}
        </div>
    );
}
