/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useEffect, useState } from "react";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../stores/NexusVoiceStore";
import MemberAvatar from "../avatars/MemberAvatar";

interface NexusVoiceParticipantGridProps {
    roomId: string;
}

/**
 * Discord-style participant grid for voice channels.
 * Shows avatar tiles for each participant in the VC.
 * Only displayed when the local user is connected.
 */
export function NexusVoiceParticipantGrid({ roomId }: NexusVoiceParticipantGridProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const [members, setMembers] = useState<RoomMember[]>([]);
    const [connected, setConnected] = useState(false);

    useEffect(() => {
        const room = client.getRoom(roomId);
        if (!room) return;

        const session = client.matrixRTC.getRoomSession(room);

        const updateMembers = (): void => {
            const conn = NexusVoiceStore.instance.getConnection(roomId);
            const isConnected = conn?.connected ?? false;
            setConnected(isConnected);

            const participantMembers: RoomMember[] = [];
            const seen = new Set<string>();
            const myUserId = client.getUserId();

            for (const membership of session.memberships) {
                const sender = membership.sender;
                if (!sender || seen.has(sender)) continue;
                // Filter own stale membership if not connected
                if (sender === myUserId && !isConnected) continue;
                seen.add(sender);
                const member = room.getMember(sender);
                if (member) participantMembers.push(member);
            }

            setMembers(participantMembers);
        };

        updateMembers();
        session.on(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);
        const onActiveConn = (): void => updateMembers();
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConn);

        return () => {
            session.off(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConn);
        };
    }, [client, roomId]);

    if (!connected || members.length === 0) return null;

    return (
        <div className="mx_NexusVoiceParticipantGrid">
            {members.map((member) => (
                <ParticipantTile key={member.userId} member={member} />
            ))}
        </div>
    );
}

interface ParticipantTileProps {
    member: RoomMember;
}

function ParticipantTile({ member }: ParticipantTileProps): JSX.Element {
    return (
        <div className="mx_NexusVoiceParticipantTile">
            <MemberAvatar member={member} size="64px" hideTitle />
            <span className="mx_NexusVoiceParticipantTile_name">{member.name}</span>
        </div>
    );
}
