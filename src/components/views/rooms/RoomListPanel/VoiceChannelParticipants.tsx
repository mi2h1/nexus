/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useCallback, useEffect, useState } from "react";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMember } from "matrix-js-sdk/src/matrix";
import classNames from "classnames";
import { MicOffSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../../stores/NexusVoiceStore";
import { useNexusActiveSpeakers } from "../../../../hooks/useNexusActiveSpeakers";
import { useNexusParticipantStates } from "../../../../hooks/useNexusParticipantStates";
import MemberAvatar from "../../avatars/MemberAvatar";
import { NexusParticipantContextMenu } from "../../voip/NexusParticipantContextMenu";

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
    const participantStates = useNexusParticipantStates();

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

    const myUserId = client.getUserId();

    if (members.length === 0) return null;

    return (
        <div className="mx_VoiceChannelParticipants">
            {members.map((member) => (
                <VoiceChannelParticipantItem
                    key={member.userId}
                    member={member}
                    isSpeaking={activeSpeakers.has(member.userId)}
                    participantState={participantStates.get(member.userId)}
                    myUserId={myUserId}
                />
            ))}
        </div>
    );
}

function VoiceChannelParticipantItem({
    member,
    isSpeaking,
    participantState,
    myUserId,
}: {
    member: RoomMember;
    isSpeaking: boolean;
    participantState?: { isMuted: boolean; isScreenSharing: boolean };
    myUserId: string | null;
}): JSX.Element {
    const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

    const onContextMenu = useCallback(
        (e: React.MouseEvent): void => {
            if (myUserId && member.userId === myUserId) return;
            e.preventDefault();
            setMenuPos({ left: e.clientX, top: e.clientY });
        },
        [myUserId, member.userId],
    );

    const onMenuFinished = useCallback((): void => {
        setMenuPos(null);
    }, []);

    const avatarClass = classNames("mx_VoiceChannelParticipants_avatar", {
        "mx_VoiceChannelParticipants_avatar--speaking": isSpeaking,
    });

    return (
        <div className="mx_VoiceChannelParticipants_item" onContextMenu={onContextMenu}>
            <div className={avatarClass}>
                <MemberAvatar member={member} size="20px" hideTitle />
            </div>
            <span className="mx_VoiceChannelParticipants_name">{member.name}</span>
            {participantState?.isMuted && (
                <MicOffSolidIcon
                    className="mx_VoiceChannelParticipants_muteIcon"
                    width={14}
                    height={14}
                />
            )}
            {participantState?.isScreenSharing && (
                <span className="mx_VoiceChannelParticipants_sharingBadge">配信中</span>
            )}
            {menuPos && (
                <NexusParticipantContextMenu
                    member={member}
                    left={menuPos.left}
                    top={menuPos.top}
                    onFinished={onMenuFinished}
                />
            )}
        </div>
    );
}
