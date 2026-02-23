/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useEffect, useState, useCallback } from "react";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMember } from "matrix-js-sdk/src/matrix";
import classNames from "classnames";
import { MicOffSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../stores/NexusVoiceStore";
import { useNexusActiveSpeakers } from "../../../hooks/useNexusActiveSpeakers";
import { useNexusParticipantStates } from "../../../hooks/useNexusParticipantStates";
import MemberAvatar from "../avatars/MemberAvatar";
import { NexusParticipantContextMenu } from "./NexusParticipantContextMenu";

interface NexusVoiceParticipantGridProps {
    roomId: string;
}

/**
 * Discord-style participant grid for voice channels.
 * Shows avatar tiles for each participant in the VC.
 * Speaking participants get a green border highlight.
 * Only displayed when the local user is connected.
 */
export function NexusVoiceParticipantGrid({ roomId }: NexusVoiceParticipantGridProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const [members, setMembers] = useState<RoomMember[]>([]);
    const [connected, setConnected] = useState(false);
    const activeSpeakers = useNexusActiveSpeakers();
    const participantStates = useNexusParticipantStates();

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

    const myUserId = client.getUserId();

    return (
        <div className="mx_NexusVoiceParticipantGrid">
            {members.map((member) => {
                const state = participantStates.get(member.userId);
                return (
                    <ParticipantTile
                        key={member.userId}
                        member={member}
                        isSpeaking={activeSpeakers.has(member.userId)}
                        isMuted={state?.isMuted ?? false}
                        isScreenSharing={state?.isScreenSharing ?? false}
                        myUserId={myUserId}
                    />
                );
            })}
        </div>
    );
}

interface ParticipantTileProps {
    member: RoomMember;
    isSpeaking: boolean;
    isMuted: boolean;
    isScreenSharing: boolean;
    myUserId?: string | null;
    size?: "normal" | "small";
}

export function ParticipantTile({ member, isSpeaking, isMuted, isScreenSharing, myUserId, size = "normal" }: ParticipantTileProps): JSX.Element {
    const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

    const onContextMenu = useCallback(
        (e: React.MouseEvent): void => {
            // Don't show volume menu for own tile
            if (myUserId && member.userId === myUserId) return;
            e.preventDefault();
            setMenuPos({ left: e.clientX, top: e.clientY });
        },
        [myUserId, member.userId],
    );

    const onMenuFinished = useCallback((): void => {
        setMenuPos(null);
    }, []);

    const tileClass = classNames("mx_NexusVoiceParticipantTile", {
        "mx_NexusVoiceParticipantTile--speaking": isSpeaking,
        "mx_NexusVoiceParticipantTile--small": size === "small",
    });

    return (
        <div className={tileClass} onContextMenu={onContextMenu}>
            <MemberAvatar member={member} size={size === "small" ? "48px" : "64px"} hideTitle />
            <div className="mx_NexusVoiceParticipantTile_nameRow">
                {isMuted && (
                    <MicOffSolidIcon
                        className="mx_NexusVoiceParticipantTile_muteIcon"
                        width={14}
                        height={14}
                    />
                )}
                {isScreenSharing && (
                    <span className="mx_NexusVoiceParticipantTile_sharingBadge">共有中</span>
                )}
                <span className="mx_NexusVoiceParticipantTile_name">{member.name}</span>
            </div>
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
