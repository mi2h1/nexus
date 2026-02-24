/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect } from "react";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMember } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../contexts/MatrixClientContext";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import { CallEvent, ConnectionState } from "../models/Call";

interface VCParticipantsResult {
    members: RoomMember[];
    connected: boolean;
    /** User IDs currently connecting or disconnecting (shown as grayed-out spinner) */
    transitioningIds: Set<string>;
}

/**
 * Hook that subscribes to MatrixRTC session memberships and the active
 * NexusVoiceConnection to return the list of VC participants for a room.
 *
 * When connected, reads from NexusVoiceConnection.participants which merges
 * LiveKit (fast path) and MatrixRTC (authoritative) data.
 * When not connected, falls back to session.memberships directly.
 */
export function useVCParticipants(roomId: string): VCParticipantsResult {
    const client = useMatrixClientContext();
    const [members, setMembers] = useState<RoomMember[]>([]);
    const [connected, setConnected] = useState(false);
    const [transitioningIds, setTransitioningIds] = useState<Set<string>>(new Set());

    useEffect(() => {
        const room = client.getRoom(roomId);
        if (!room) return;

        const session = client.matrixRTC.getRoomSession(room);
        const myUserId = client.getUserId();

        const updateMembers = (): void => {
            const conn = NexusVoiceStore.instance.getConnection(roomId);
            const isConnected = conn?.connected ?? false;
            const connState = conn?.connectionState;
            setConnected(isConnected);

            const isTransitioning =
                connState === ConnectionState.Connecting ||
                connState === ConnectionState.Disconnecting;

            setTransitioningIds(isTransitioning && myUserId ? new Set([myUserId]) : new Set());

            // 接続中: NexusVoiceConnection.participants を使う（LiveKit + MatrixRTC マージ済み）
            if (conn && isConnected) {
                setMembers([...conn.participants.keys()]);
                return;
            }

            // 未接続 or 遷移中: session.memberships から読む
            const participantMembers: RoomMember[] = [];
            const seen = new Set<string>();

            for (const membership of session.memberships) {
                const sender = membership.sender;
                if (!sender || seen.has(sender)) continue;
                // 未接続（かつ遷移中でもない）なら自分は除外
                if (sender === myUserId && !isTransitioning) continue;
                seen.add(sender);
                const member = room.getMember(sender);
                if (member) participantMembers.push(member);
            }

            // 接続中（Connecting）で自分がまだ memberships に出ていない場合も追加
            if (isTransitioning && myUserId && !seen.has(myUserId)) {
                const myMember = room.getMember(myUserId);
                if (myMember) participantMembers.push(myMember);
            }

            setMembers(participantMembers);
        };

        updateMembers();
        session.on(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);

        // 接続中は CallEvent.Participants と ConnectionState も購読
        let currentConn = NexusVoiceStore.instance.getConnection(roomId) ?? null;
        const onParticipants = (): void => updateMembers();
        const onConnectionState = (): void => updateMembers();
        currentConn?.on(CallEvent.Participants, onParticipants);
        currentConn?.on(CallEvent.ConnectionState, onConnectionState);

        // ActiveConnection が変わったら リスナーを付け替え
        const onConnChange = (): void => {
            currentConn?.off(CallEvent.Participants, onParticipants);
            currentConn?.off(CallEvent.ConnectionState, onConnectionState);
            currentConn = NexusVoiceStore.instance.getConnection(roomId) ?? null;
            currentConn?.on(CallEvent.Participants, onParticipants);
            currentConn?.on(CallEvent.ConnectionState, onConnectionState);
            updateMembers();
        };
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onConnChange);

        return () => {
            session.off(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onConnChange);
            currentConn?.off(CallEvent.Participants, onParticipants);
            currentConn?.off(CallEvent.ConnectionState, onConnectionState);
        };
    }, [client, roomId]);

    return { members, connected, transitioningIds };
}
