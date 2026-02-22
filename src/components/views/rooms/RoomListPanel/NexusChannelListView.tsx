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
import { type Room } from "matrix-js-sdk/src/matrix";

import { useChannelSeparation } from "../../../../hooks/useChannelSeparation";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { VoiceChannelParticipants } from "./VoiceChannelParticipants";
import { TextChannelIcon, VoiceChannelIcon } from "./NexusChannelIcon";
import { NexusVoiceStore } from "../../../../stores/NexusVoiceStore";

export interface NexusChannelListViewProps {
    vm: RoomListViewModel;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Discord-style channel list with text/voice separation.
 * Replaces SharedRoomListView to display rooms in two sections:
 * 1. Text channels (all non-video rooms)
 * 2. Voice channels (video rooms / RoomType.UnstableCall)
 */
export function NexusChannelListView({ vm, onKeyDown }: NexusChannelListViewProps): JSX.Element {
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

    // Channel-type-specific avatar renderers
    // NOTE: Must be above early returns to satisfy React hooks rules
    const renderTextChannelAvatar = useCallback(
        (_room: SharedRoom): ReactNode => <TextChannelIcon />,
        [],
    );
    const renderVoiceChannelAvatar = useCallback(
        (room: SharedRoom): ReactNode => <VoiceChannelIcon roomId={(room as Room).roomId} />,
        [],
    );

    // Loading state
    if (snapshot.isLoadingRooms) {
        return <RoomListLoadingSkeleton />;
    }

    // Empty state
    if (snapshot.isRoomListEmpty) {
        return <RoomListEmptyStateView vm={vm} />;
    }

    const totalRoomCount = allRoomIds.length;

    const renderRoomItem = (
        roomId: string,
        globalIndex: number,
        avatarRenderer: (room: SharedRoom) => ReactNode,
    ): JSX.Element => {
        const roomItemVM = vm.getRoomItemViewModel(roomId);
        const isSelected = activeRoomIndex === globalIndex;
        const isFocused = hasFocus && focusedRoomId === roomId;

        return (
            <RoomListItemView
                key={roomId}
                vm={roomItemVM}
                renderAvatar={avatarRenderer}
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
                    {textRoomIds.map((roomId) =>
                        renderRoomItem(roomId, globalIndexMap.get(roomId) ?? 0, renderTextChannelAvatar),
                    )}
                </div>
            )}

            {/* Voice Channels */}
            {voiceRoomIds.length > 0 && (
                <div className="mx_NexusChannelList_section">
                    <div className="mx_NexusChannelList_sectionHeader">VOICE CHANNELS</div>
                    {voiceRoomIds.map((roomId) => (
                        <VoiceChannelItem
                            key={roomId}
                            roomId={roomId}
                            globalIndex={globalIndexMap.get(roomId) ?? 0}
                            renderItem={renderRoomItem}
                            avatarRenderer={renderVoiceChannelAvatar}
                            matrixClient={matrixClient}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Wrapper for voice channel items that intercepts clicks to join/leave
 * via NexusVoiceStore instead of navigating to the room view.
 */
function VoiceChannelItem({
    roomId,
    globalIndex,
    renderItem,
    avatarRenderer,
    matrixClient,
}: {
    roomId: string;
    globalIndex: number;
    renderItem: (roomId: string, globalIndex: number, avatarRenderer: (room: SharedRoom) => ReactNode) => JSX.Element;
    avatarRenderer: (room: SharedRoom) => ReactNode;
    matrixClient: ReturnType<typeof useMatrixClientContext>;
}): JSX.Element {
    const onVoiceChannelClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();

            const room = matrixClient.getRoom(roomId);
            if (!room) return;

            const store = NexusVoiceStore.instance;
            const existing = store.getConnection(roomId);
            if (existing?.connected) {
                // Already in this VC — leave
                store.leaveVoiceChannel().catch(() => {});
            } else {
                // Join (will disconnect from any other VC)
                store.joinVoiceChannel(room).catch(() => {});
            }
        },
        [matrixClient, roomId],
    );

    return (
        <React.Fragment>
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div onClick={onVoiceChannelClick}>
                {renderItem(roomId, globalIndex, avatarRenderer)}
            </div>
            <VoiceChannelParticipants roomId={roomId} />
        </React.Fragment>
    );
}
