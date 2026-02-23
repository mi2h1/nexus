/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useEffect, useState } from "react";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMember } from "matrix-js-sdk/src/matrix";
import classNames from "classnames";

import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../../stores/NexusVoiceStore";
import { useNexusActiveSpeakers } from "../../../../hooks/useNexusActiveSpeakers";
import MemberAvatar from "../../avatars/MemberAvatar";

interface VoiceChannelParticipantsProps {
    roomId: string;
}

/**
 * Displays the list of participants currently in a voice channel,
 * shown below the channel name in Discord style.
 *
 * Reads MatrixRTC session memberships directly instead of depending
 * on a local NexusVoiceConnection — so participants remain visible
 * even when the local user is not in the VC.
 *
 * Speaking participants get a green border on their avatar.
 */
export function VoiceChannelParticipants({ roomId }: VoiceChannelParticipantsProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const [members, setMembers] = useState<RoomMember[]>([]);
    const activeSpeakers = useNexusActiveSpeakers();

    useEffect(() => {
        const room = client.getRoom(roomId);
        if (!room) return;

        const myUserId = client.getUserId();
        const session = client.matrixRTC.getRoomSession(room);

        const updateMembers = (): void => {
            const participantMembers: RoomMember[] = [];
            const seen = new Set<string>();

            // Check if the local user is actually connected to this VC
            const localConn = NexusVoiceStore.instance.getConnection(roomId);
            const localConnected = localConn?.connected ?? false;

            for (const membership of session.memberships) {
                const sender = membership.sender;
                if (!sender || seen.has(sender)) continue;

                // Filter out our own stale membership if we're not connected
                if (sender === myUserId && !localConnected) continue;

                seen.add(sender);
                const member = room.getMember(sender);
                if (member) {
                    participantMembers.push(member);
                }
            }

            setMembers(participantMembers);
        };

        // Initial update
        updateMembers();

        // Listen for membership changes
        session.on(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);

        // Also update when the local voice connection changes
        const onActiveConnection = (): void => updateMembers();
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);

        return () => {
            session.off(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, [client, roomId]);

    if (members.length === 0) return null;

    return (
        <div className="mx_VoiceChannelParticipants">
            {members.map((member) => {
                const speaking = activeSpeakers.has(member.userId);
                const avatarClass = classNames("mx_VoiceChannelParticipants_avatar", {
                    "mx_VoiceChannelParticipants_avatar--speaking": speaking,
                });
                return (
                    <div className="mx_VoiceChannelParticipants_item" key={member.userId}>
                        <div className={avatarClass}>
                            <MemberAvatar member={member} size="20px" hideTitle />
                        </div>
                        <span className="mx_VoiceChannelParticipants_name">{member.name}</span>
                    </div>
                );
            })}
        </div>
    );
}
