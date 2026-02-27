/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect } from "react";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMember, RoomStateEvent } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../contexts/MatrixClientContext";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import { CallEvent, ConnectionState } from "../models/Call";

export interface VCParticipant {
    userId: string;
    member: RoomMember | null;
}

interface VCParticipantsResult {
    members: VCParticipant[];
    connected: boolean;
    /** User IDs currently connecting or disconnecting (shown as grayed-out spinner) */
    transitioningIds: Set<string>;
    /** Timestamp (ms) when the first participant joined the current call, or null if empty */
    callStartedTs: number | null;
}

/**
 * Hook that subscribes to MatrixRTC session memberships and the active
 * NexusVoiceConnection to return the list of VC participants for a room.
 *
 * When connected, reads from NexusVoiceConnection.participants which merges
 * LiveKit (fast path) and MatrixRTC (authoritative) data.
 * When not connected, falls back to session.memberships directly.
 *
 * Also listens for room state changes so that RoomMember objects are resolved
 * as soon as the initial Matrix /sync completes.
 */
export function useVCParticipants(roomId: string): VCParticipantsResult {
    const client = useMatrixClientContext();
    const [members, setMembers] = useState<VCParticipant[]>([]);
    const [connected, setConnected] = useState(false);
    const [transitioningIds, setTransitioningIds] = useState<Set<string>>(new Set());
    const [callStartedTs, setCallStartedTs] = useState<number | null>(null);

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

            // 接続中: NexusVoiceConnection.participants を使う（userId → devices マップ）
            if (conn && isConnected) {
                const participantIds = new Set(conn.participants.keys());
                const participantList: VCParticipant[] = [];
                for (const userId of participantIds) {
                    participantList.push({
                        userId,
                        member: room.getMember(userId),
                    });
                }
                // Ensure self stays in list even if MatrixRTC membership hasn't arrived yet
                if (myUserId && !participantIds.has(myUserId)) {
                    participantIds.add(myUserId);
                    participantList.push({
                        userId: myUserId,
                        member: room.getMember(myUserId),
                    });
                }
                setMembers(participantList);

                // callStartedTs: 実際の参加者の membership だけから最古を取得
                let startedTs: number | null = null;
                for (const m of session.memberships) {
                    if (!m.sender || !participantIds.has(m.sender)) continue;
                    const ts = m.createdTs();
                    if (startedTs === null || ts < startedTs) startedTs = ts;
                }
                setCallStartedTs(startedTs);
                return;
            }

            // 未接続 or 遷移中: session.memberships から読む
            const participantList: VCParticipant[] = [];
            const seen = new Set<string>();

            for (const membership of session.memberships) {
                const sender = membership.sender;
                if (!sender || seen.has(sender)) continue;
                // 未接続（かつ遷移中でもない）なら自分は除外
                if (sender === myUserId && !isTransitioning) continue;
                seen.add(sender);
                participantList.push({
                    userId: sender,
                    member: room.getMember(sender),
                });
            }

            // 接続中（Connecting）で自分がまだ memberships に出ていない場合も追加
            if (isTransitioning && myUserId && !seen.has(myUserId)) {
                participantList.push({
                    userId: myUserId,
                    member: room.getMember(myUserId),
                });
            }

            setMembers(participantList);

            // 未接続時は経過時間を表示しない（stale membership 対策）
            setCallStartedTs(null);
        };

        updateMembers();
        session.on(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);

        // Room state listener: re-resolve RoomMember when member data arrives from /sync
        const roomState = room.currentState;
        // Multiple hook instances (room list, VC view, channel icon) subscribe
        // to the same RoomState — raise the limit to avoid spurious warnings.
        if (roomState.getMaxListeners() < 50) roomState.setMaxListeners(50);
        roomState.on(RoomStateEvent.Members, updateMembers);

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

        // 未接続時 30s ポーリング: サーバーが sticky event を TTL 削除 → sync 反映の
        // タイミング遅延やイベント欠落に対する安全策。接続中は LiveKit イベントで
        // 即時更新されるのでポーリング不要。
        const pollInterval = window.setInterval(() => {
            const conn = NexusVoiceStore.instance.getConnection(roomId);
            if (!conn?.connected) updateMembers();
        }, 30_000);

        // マウント直後の高頻度ポーリング: 初回 sync 中は membership が段階的に
        // 到着し、stale なエントリが一時的に表示されることがある。最初の 15 秒間
        // だけ 3 秒間隔でポーリングし、sync 完了後の membership 変化を素早く反映。
        const FAST_POLL_INTERVAL = 3_000;
        const FAST_POLL_DURATION = 15_000;
        const fastPollInterval = window.setInterval(() => {
            const conn = NexusVoiceStore.instance.getConnection(roomId);
            if (!conn?.connected) updateMembers();
        }, FAST_POLL_INTERVAL);
        const fastPollTimeout = window.setTimeout(() => {
            clearInterval(fastPollInterval);
        }, FAST_POLL_DURATION);

        return () => {
            session.off(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);
            roomState.off(RoomStateEvent.Members, updateMembers);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onConnChange);
            currentConn?.off(CallEvent.Participants, onParticipants);
            currentConn?.off(CallEvent.ConnectionState, onConnectionState);
            clearInterval(pollInterval);
            clearInterval(fastPollInterval);
            clearTimeout(fastPollTimeout);
        };
    }, [client, roomId]);

    return { members, connected, transitioningIds, callStartedTs };
}
