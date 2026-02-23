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
import { CallEvent } from "../models/Call";

interface VCParticipantsResult {
    members: RoomMember[];
    connected: boolean;
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

    useEffect(() => {
        const room = client.getRoom(roomId);
        if (!room) return;

        const session = client.matrixRTC.getRoomSession(room);

        const updateMembers = (): void => {
            const conn = NexusVoiceStore.instance.getConnection(roomId);
            const isConnected = conn?.connected ?? false;
            setConnected(isConnected);

            // 接続中: NexusVoiceConnection.participants を使う（LiveKit + MatrixRTC マージ済み）
            if (conn && isConnected) {
                setMembers([...conn.participants.keys()]);
                return;
            }

            // 未接続: session.memberships から直接読む（他人の VC を外から見る場合）
            const participantMembers: RoomMember[] = [];
            const seen = new Set<string>();
            const myUserId = client.getUserId();

            for (const membership of session.memberships) {
                const sender = membership.sender;
                if (!sender || seen.has(sender)) continue;
                if (sender === myUserId) continue; // 未接続なので自分は除外
                seen.add(sender);
                const member = room.getMember(sender);
                if (member) participantMembers.push(member);
            }

            setMembers(participantMembers);
        };

        updateMembers();
        session.on(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);

        // 接続中は CallEvent.Participants も購読
        let currentConn = NexusVoiceStore.instance.getConnection(roomId) ?? null;
        const onParticipants = (): void => updateMembers();
        currentConn?.on(CallEvent.Participants, onParticipants);

        // ActiveConnection が変わったら Participants リスナーを付け替え
        const onConnChange = (): void => {
            currentConn?.off(CallEvent.Participants, onParticipants);
            currentConn = NexusVoiceStore.instance.getConnection(roomId) ?? null;
            currentConn?.on(CallEvent.Participants, onParticipants);
            updateMembers();
        };
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onConnChange);

        return () => {
            session.off(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onConnChange);
            currentConn?.off(CallEvent.Participants, onParticipants);
        };
    }, [client, roomId]);

    return { members, connected };
}
