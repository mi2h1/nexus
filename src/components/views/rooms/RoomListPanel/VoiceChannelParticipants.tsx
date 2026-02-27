/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useCallback, useState } from "react";

import classNames from "classnames";
import { MicOffSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { useVCParticipants, type VCParticipantInfo } from "../../../../hooks/useVCParticipants";
import MemberAvatar from "../../avatars/MemberAvatar";
import BaseAvatar from "../../avatars/BaseAvatar";
import InlineSpinner from "../../elements/InlineSpinner";
import { NexusParticipantContextMenu } from "../../voip/NexusParticipantContextMenu";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../../stores/NexusVoiceStore";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { Action } from "../../../../dispatcher/actions";

interface VoiceChannelParticipantsProps {
    roomId: string;
}

/**
 * Displays the list of participants currently in a voice channel,
 * shown below the channel name in Discord style.
 *
 * Speaking participants get a green border on their avatar.
 */
export function VoiceChannelParticipants({ roomId }: VoiceChannelParticipantsProps): JSX.Element | null {
    const { participants } = useVCParticipants(roomId);

    if (participants.length === 0) return null;

    return (
        <div className="mx_VoiceChannelParticipants">
            {participants.map((p) => (
                <VoiceChannelParticipantItem key={p.userId} participant={p} roomId={roomId} />
            ))}
        </div>
    );
}

function VoiceChannelParticipantItem({
    participant,
    roomId,
}: {
    participant: VCParticipantInfo;
    roomId: string;
}): JSX.Element {
    const client = useMatrixClientContext();
    const myUserId = client.getUserId();
    const { userId, member, isSpeaking, isMuted, isScreenSharing, isTransitioning } = participant;
    const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

    const onContextMenu = useCallback(
        (e: React.MouseEvent): void => {
            if (myUserId && userId === myUserId) return;
            if (isTransitioning) return;
            if (!member) return; // Can't show context menu without RoomMember
            e.preventDefault();
            setMenuPos({ left: e.clientX, top: e.clientY });
        },
        [myUserId, userId, isTransitioning, member],
    );

    const onMenuFinished = useCallback((): void => {
        setMenuPos(null);
    }, []);

    const onDoubleClick = useCallback((): void => {
        if (!isScreenSharing || isTransitioning) return;
        const conn = NexusVoiceStore.instance.getActiveConnection();
        if (!conn) return;
        const share = conn.screenShares.find((s) => s.participantIdentity === userId);
        if (!share) return;
        conn.setScreenShareWatching(share.participantIdentity, true);
        NexusVoiceStore.instance.emit(
            NexusVoiceStoreEvent.RequestSpotlight,
            share.participantIdentity,
        );
        defaultDispatcher.dispatch({ action: Action.ViewRoom, room_id: roomId });
    }, [userId, isScreenSharing, isTransitioning, roomId]);

    const itemClass = classNames("mx_VoiceChannelParticipants_item", {
        "mx_VoiceChannelParticipants_item--transitioning": isTransitioning,
    });

    const avatarClass = classNames("mx_VoiceChannelParticipants_avatar", {
        "mx_VoiceChannelParticipants_avatar--speaking": isSpeaking && !isTransitioning,
    });

    const displayName = member?.name ?? userId;

    return (
        <div className={itemClass} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick}>
            <div className={avatarClass}>
                {isTransitioning ? (
                    <InlineSpinner size={20} />
                ) : member ? (
                    <MemberAvatar member={member} size="20px" hideTitle />
                ) : (
                    <BaseAvatar name={userId} size="20px" />
                )}
            </div>
            <span className="mx_VoiceChannelParticipants_name">{displayName}</span>
            {!isTransitioning && isMuted && (
                <MicOffSolidIcon
                    className="mx_VoiceChannelParticipants_muteIcon"
                    width={14}
                    height={14}
                />
            )}
            {!isTransitioning && isScreenSharing && (
                <span className="mx_VoiceChannelParticipants_sharingBadge">配信中</span>
            )}
            {menuPos && member && (
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
