/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import { type RoomMember } from "matrix-js-sdk/src/matrix";
import classNames from "classnames";
import { IconMicrophoneOff } from "@tabler/icons-react";

import MemberAvatar from "../avatars/MemberAvatar";

interface ParticipantTileProps {
    member: RoomMember;
    isSpeaking: boolean;
    isMuted: boolean;
    isScreenSharing: boolean;
    onClick?: () => void;
}

export function ParticipantTile({ member, isSpeaking, isMuted, isScreenSharing, size = "normal", onClick }: ParticipantTileProps & { size?: "normal" | "small" }): JSX.Element {
    const tileClass = classNames("mx_NexusVoiceParticipantTile", {
        "mx_NexusVoiceParticipantTile--speaking": isSpeaking,
        "mx_NexusVoiceParticipantTile--small": size === "small",
        "mx_NexusVoiceParticipantTile--clickable": !!onClick,
    });

    return (
        <div className={tileClass} onClick={onClick}>
            <MemberAvatar member={member} size={size === "small" ? "48px" : "64px"} hideTitle />
            <div className="mx_NexusVoiceParticipantTile_nameRow">
                {isMuted && (
                    <IconMicrophoneOff
                        className="mx_NexusVoiceParticipantTile_muteIcon"
                        size={14}
                    />
                )}
                {isScreenSharing && (
                    <span className="mx_NexusVoiceParticipantTile_sharingBadge">配信中</span>
                )}
                <span className="mx_NexusVoiceParticipantTile_name">{member.name}</span>
            </div>
        </div>
    );
}
