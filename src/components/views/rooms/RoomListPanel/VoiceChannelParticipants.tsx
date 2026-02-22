/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";

import { useCall, useParticipatingMembers } from "../../../../hooks/useCall";
import type { Call } from "../../../../models/Call";
import type { NexusVoiceConnection } from "../../../../models/NexusVoiceConnection";
import MemberAvatar from "../../avatars/MemberAvatar";

interface VoiceChannelParticipantsProps {
    roomId: string;
}

/**
 * Displays the list of participants currently in a voice channel,
 * shown below the channel name in Discord style.
 */
export function VoiceChannelParticipants({ roomId }: VoiceChannelParticipantsProps): JSX.Element | null {
    const call = useCall(roomId);

    if (!call) return null;

    return <VoiceChannelParticipantsList call={call} />;
}

/**
 * Inner component that renders the participant list.
 * Separated so useParticipatingMembers (which requires non-null Call) is only called when a call exists.
 */
function VoiceChannelParticipantsList({ call }: { call: Call | NexusVoiceConnection }): JSX.Element | null {
    const members = useParticipatingMembers(call);

    if (members.length === 0) return null;

    return (
        <div className="mx_VoiceChannelParticipants">
            {members.map((member, index) => (
                <div className="mx_VoiceChannelParticipants_item" key={`${member.userId}-${index}`}>
                    <MemberAvatar member={member} size="20px" hideTitle />
                    <span className="mx_VoiceChannelParticipants_name">{member.name}</span>
                </div>
            ))}
        </div>
    );
}
