/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useCallback, useState } from "react";
import { type RoomMember } from "matrix-js-sdk/src/matrix";
import classNames from "classnames";
import { MicOffSolidIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { useNexusActiveSpeakers } from "../../../../hooks/useNexusActiveSpeakers";
import { useNexusParticipantStates } from "../../../../hooks/useNexusParticipantStates";
import { useVCParticipants } from "../../../../hooks/useVCParticipants";
import MemberAvatar from "../../avatars/MemberAvatar";
import InlineSpinner from "../../elements/InlineSpinner";
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
    const { members, transitioningIds } = useVCParticipants(roomId);
    const activeSpeakers = useNexusActiveSpeakers();
    const participantStates = useNexusParticipantStates();
    const myUserId = client.getUserId();

    if (members.length === 0) return null;

    return (
        <div className="mx_VoiceChannelParticipants">
            {members.map((member) => (
                <VoiceChannelParticipantItem
                    key={member.userId}
                    member={member}
                    isSpeaking={activeSpeakers.has(member.userId)}
                    isTransitioning={transitioningIds.has(member.userId)}
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
    isTransitioning,
    participantState,
    myUserId,
}: {
    member: RoomMember;
    isSpeaking: boolean;
    isTransitioning: boolean;
    participantState?: { isMuted: boolean; isScreenSharing: boolean };
    myUserId: string | null;
}): JSX.Element {
    const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

    const onContextMenu = useCallback(
        (e: React.MouseEvent): void => {
            if (myUserId && member.userId === myUserId) return;
            if (isTransitioning) return;
            e.preventDefault();
            setMenuPos({ left: e.clientX, top: e.clientY });
        },
        [myUserId, member.userId, isTransitioning],
    );

    const onMenuFinished = useCallback((): void => {
        setMenuPos(null);
    }, []);

    const itemClass = classNames("mx_VoiceChannelParticipants_item", {
        "mx_VoiceChannelParticipants_item--transitioning": isTransitioning,
    });

    const avatarClass = classNames("mx_VoiceChannelParticipants_avatar", {
        "mx_VoiceChannelParticipants_avatar--speaking": isSpeaking && !isTransitioning,
    });

    return (
        <div className={itemClass} onContextMenu={onContextMenu}>
            <div className={avatarClass}>
                {isTransitioning ? (
                    <InlineSpinner size={20} />
                ) : (
                    <MemberAvatar member={member} size="20px" hideTitle />
                )}
            </div>
            <span className="mx_VoiceChannelParticipants_name">{member.name}</span>
            {!isTransitioning && participantState?.isMuted && (
                <MicOffSolidIcon
                    className="mx_VoiceChannelParticipants_muteIcon"
                    width={14}
                    height={14}
                />
            )}
            {!isTransitioning && participantState?.isScreenSharing && (
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
