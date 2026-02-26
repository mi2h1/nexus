/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import classNames from "classnames";
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
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../../stores/NexusVoiceStore";
import { CallEvent, ConnectionState } from "../../../../models/Call";
import { useVCParticipants } from "../../../../hooks/useVCParticipants";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { Action } from "../../../../dispatcher/actions";
import { ChatSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

/**
 * Format elapsed milliseconds as "H:MM:SS" or "M:SS".
 */
function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Hook that returns a formatted elapsed-time string updated every second.
 */
function useElapsedTime(startTs: number | null): string | null {
    const [elapsed, setElapsed] = useState<string | null>(null);

    useEffect(() => {
        if (startTs === null) {
            setElapsed(null);
            return;
        }
        const update = (): void => setElapsed(formatElapsed(Math.max(0, Date.now() - startTs)));
        update();
        const id = window.setInterval(update, 1000);
        return () => window.clearInterval(id);
    }, [startTs]);

    return elapsed;
}

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
    const [isTransitioning, setIsTransitioning] = useState(false);
    const { members, callStartedTs } = useVCParticipants(roomId);
    const hasParticipants = members.length > 0;
    const elapsed = useElapsedTime(hasParticipants ? callStartedTs : null);

    useEffect(() => {
        const store = NexusVoiceStore.instance;
        const myUserId = matrixClient.getUserId();
        let currentConn = store.getConnection(roomId) ?? null;

        const updateState = (): void => {
            const conn = store.getConnection(roomId);
            if (!conn) {
                setIsTransitioning(false);
                return;
            }
            const state = conn.connectionState;
            if (state === ConnectionState.Connecting || state === ConnectionState.Disconnecting) {
                setIsTransitioning(true);
                return;
            }
            if (state === ConnectionState.Connected) {
                // Keep spinner until local user appears in participant list
                let selfInList = false;
                for (const [userId] of conn.participants) {
                    if (userId === myUserId) {
                        selfInList = true;
                        break;
                    }
                }
                setIsTransitioning(!selfInList);
                return;
            }
            setIsTransitioning(false);
        };

        const onActiveConnection = (): void => {
            if (currentConn) {
                currentConn.off(CallEvent.ConnectionState, updateState);
                currentConn.off(CallEvent.Participants, updateState);
            }
            currentConn = store.getConnection(roomId) ?? null;
            if (currentConn) {
                currentConn.on(CallEvent.ConnectionState, updateState);
                currentConn.on(CallEvent.Participants, updateState);
            }
            updateState();
        };

        store.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        // Initial setup
        if (currentConn) {
            currentConn.on(CallEvent.ConnectionState, updateState);
            currentConn.on(CallEvent.Participants, updateState);
        }
        updateState();

        return () => {
            store.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
            if (currentConn) {
                currentConn.off(CallEvent.ConnectionState, updateState);
                currentConn.off(CallEvent.Participants, updateState);
            }
        };
    }, [roomId, matrixClient]);

    const onVoiceChannelClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();

            // Block clicks while transitioning (connecting / waiting for membership / disconnecting)
            if (isTransitioning) return;

            const room = matrixClient.getRoom(roomId);
            if (!room) return;

            const store = NexusVoiceStore.instance;
            const existing = store.getConnection(roomId);
            if (existing?.connected) {
                // Already in this VC — navigate to room view (show call UI)
                defaultDispatcher.dispatch({
                    action: Action.ViewRoom,
                    room_id: roomId,
                });
            } else {
                // Join (will disconnect from any other VC)
                store.joinVoiceChannel(room).catch(() => {});
            }
        },
        [matrixClient, roomId, isTransitioning],
    );

    const onChatClick = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            defaultDispatcher.dispatch({
                action: Action.ViewRoom,
                room_id: roomId,
            });
        },
        [roomId],
    );

    return (
        <div className={classNames("nx_VoiceChannelGroup", {
            "nx_VoiceChannelGroup--active": hasParticipants,
        })}>
            {/* Use onClickCapture to intercept BEFORE RoomListItemView's button onClick fires */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div onClickCapture={onVoiceChannelClick} className="nx_VoiceChannelItem">
                {renderItem(roomId, globalIndex, avatarRenderer)}
                {elapsed && <span className="mx_NexusChannelIcon_elapsed">{elapsed}</span>}
                {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                <div className="nx_VoiceChannelItem_chatButton" onClickCapture={onChatClick} title="チャットを表示">
                    <ChatSolidIcon width={16} height={16} />
                </div>
            </div>
            <VoiceChannelParticipants roomId={roomId} />
        </div>
    );
}
