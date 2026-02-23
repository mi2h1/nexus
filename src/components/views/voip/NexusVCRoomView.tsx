/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState, useRef, useEffect, useCallback, type JSX, useMemo } from "react";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import { useVCParticipants } from "../../../hooks/useVCParticipants";
import { useNexusScreenShares } from "../../../hooks/useNexusScreenShares";
import { useNexusActiveSpeakers } from "../../../hooks/useNexusActiveSpeakers";
import { useNexusParticipantStates } from "../../../hooks/useNexusParticipantStates";
import { ScreenShareTile } from "./NexusScreenShareView";
import { ParticipantTile } from "./NexusVoiceParticipantGrid";
import { NexusVCControlBar, type VCLayoutMode } from "./NexusVCControlBar";
import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import type { ScreenShareInfo } from "../../../models/Call";
import MemberAvatar from "../avatars/MemberAvatar";
import AccessibleButton from "../elements/AccessibleButton";

interface NexusVCRoomViewProps {
    roomId: string;
}

const SPEAKER_DEBOUNCE_MS = 2000;

/**
 * Unified VC room view with spotlight/grid layout modes and a control bar.
 */
export function NexusVCRoomView({ roomId }: NexusVCRoomViewProps): JSX.Element | null {
    const client = useMatrixClientContext();
    const { members, connected } = useVCParticipants(roomId);
    const screenShares = useNexusScreenShares(roomId);
    const activeSpeakers = useNexusActiveSpeakers();
    const participantStates = useNexusParticipantStates();

    const [layoutMode, setLayoutMode] = useState<VCLayoutMode>("spotlight");

    // Debounced spotlight target based on active speaker
    const spotlightTarget = useSpotlightTarget(client.getUserId(), members, screenShares, activeSpeakers);

    const onJoinCall = useCallback(() => {
        const room = client.getRoom(roomId);
        if (room) {
            NexusVoiceStore.instance.joinVoiceChannel(room).catch(() => {});
        }
    }, [client, roomId]);

    if (!connected) {
        return (
            <div className="nx_VCRoomView">
                <div className="nx_VCRoomView_empty">
                    <div className="nx_VCRoomView_emptyText">まだ誰もいません</div>
                    <AccessibleButton
                        className="nx_VCRoomView_joinButton"
                        onClick={onJoinCall}
                    >
                        通話に参加する
                    </AccessibleButton>
                </div>
            </div>
        );
    }

    return (
        <div className="nx_VCRoomView">
            <div className="nx_VCRoomView_content">
                {layoutMode === "spotlight" ? (
                    <SpotlightLayout
                        spotlightTarget={spotlightTarget}
                        members={members}
                        activeSpeakers={activeSpeakers}
                        participantStates={participantStates}
                        myUserId={client.getUserId()}
                    />
                ) : (
                    <GridLayout
                        screenShares={screenShares}
                        members={members}
                        activeSpeakers={activeSpeakers}
                        participantStates={participantStates}
                    />
                )}
            </div>
            <NexusVCControlBar
                roomId={roomId}
                layoutMode={layoutMode}
                onLayoutModeChange={setLayoutMode}
                participantCount={members.length}
            />
        </div>
    );
}

// ─── Spotlight target resolution ─────────────────────────────

type SpotlightTarget =
    | { type: "screenshare"; share: ScreenShareInfo }
    | { type: "member"; member: RoomMember };

function useSpotlightTarget(
    myUserId: string | null,
    members: RoomMember[],
    screenShares: ScreenShareInfo[],
    activeSpeakers: Set<string>,
): SpotlightTarget | null {
    // Debounce speaker-based changes to avoid flickering
    const [debouncedSpeaker, setDebouncedSpeaker] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Find first active speaker that isn't me
    const otherSpeaker = useMemo(() => {
        for (const userId of activeSpeakers) {
            if (userId !== myUserId) return userId;
        }
        return null;
    }, [activeSpeakers, myUserId]);

    useEffect(() => {
        if (otherSpeaker === debouncedSpeaker) return;

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setDebouncedSpeaker(otherSpeaker);
        }, SPEAKER_DEBOUNCE_MS);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [otherSpeaker, debouncedSpeaker]);

    // Priority 1: screen share
    if (screenShares.length > 0) {
        return { type: "screenshare", share: screenShares[0] };
    }

    // Priority 2: debounced active speaker (not me)
    if (debouncedSpeaker) {
        const member = members.find((m) => m.userId === debouncedSpeaker);
        if (member) return { type: "member", member };
    }

    // Priority 3: first other member
    const otherMember = members.find((m) => m.userId !== myUserId);
    if (otherMember) return { type: "member", member: otherMember };

    // Priority 4: myself
    if (members.length > 0) return { type: "member", member: members[0] };

    return null;
}

// ─── Spotlight layout ─────────────────────────────────────────

interface SpotlightLayoutProps {
    spotlightTarget: SpotlightTarget | null;
    members: RoomMember[];
    activeSpeakers: Set<string>;
    participantStates: Map<string, { isMuted: boolean; isScreenSharing: boolean }>;
    myUserId: string | null;
}

function SpotlightLayout({
    spotlightTarget,
    members,
    activeSpeakers,
    participantStates,
    myUserId,
}: SpotlightLayoutProps): JSX.Element {
    // Sidebar members: everyone except the spotlight target (if it's a member)
    const sidebarMembers = useMemo(() => {
        if (!spotlightTarget) return members;
        if (spotlightTarget.type === "screenshare") return members;
        return members.filter((m) => m.userId !== spotlightTarget.member.userId);
    }, [spotlightTarget, members]);

    return (
        <div className="nx_VCRoomView_spotlight">
            <div className="nx_VCRoomView_spotlightMain">
                {spotlightTarget?.type === "screenshare" ? (
                    <>
                        <ScreenShareTile share={spotlightTarget.share} />
                        <div className="nx_VCRoomView_spotlightLabel">
                            {spotlightTarget.share.participantName}の画面
                        </div>
                    </>
                ) : spotlightTarget?.type === "member" ? (
                    <div className="nx_VCRoomView_spotlightAvatar">
                        <MemberAvatar member={spotlightTarget.member} size="128px" hideTitle />
                        <div className="nx_VCRoomView_spotlightAvatarName">
                            {spotlightTarget.member.name}
                        </div>
                    </div>
                ) : null}
            </div>
            {sidebarMembers.length > 0 && (
                <div className="nx_VCRoomView_spotlightSidebar">
                    {sidebarMembers.map((member) => {
                        const state = participantStates.get(member.userId);
                        return (
                            <ParticipantTile
                                key={member.userId}
                                member={member}
                                isSpeaking={activeSpeakers.has(member.userId)}
                                isMuted={state?.isMuted ?? false}
                                isScreenSharing={state?.isScreenSharing ?? false}
                                size="small"
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ─── Grid layout ──────────────────────────────────────────────

interface GridLayoutProps {
    screenShares: ScreenShareInfo[];
    members: RoomMember[];
    activeSpeakers: Set<string>;
    participantStates: Map<string, { isMuted: boolean; isScreenSharing: boolean }>;
}

function GridLayout({ screenShares, members, activeSpeakers, participantStates }: GridLayoutProps): JSX.Element {
    return (
        <div className="nx_VCRoomView_grid">
            {screenShares.map((share) => (
                <div key={`ss-${share.participantIdentity}`} className="nx_VCRoomView_gridScreenShare">
                    <ScreenShareTile share={share} />
                </div>
            ))}
            {members.map((member) => {
                const state = participantStates.get(member.userId);
                return (
                    <ParticipantTile
                        key={member.userId}
                        member={member}
                        isSpeaking={activeSpeakers.has(member.userId)}
                        isMuted={state?.isMuted ?? false}
                        isScreenSharing={state?.isScreenSharing ?? false}
                    />
                );
            })}
        </div>
    );
}
