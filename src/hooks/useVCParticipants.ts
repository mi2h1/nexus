/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect, useMemo } from "react";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/src/matrixrtc";
import { type RoomMember, RoomStateEvent } from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import { useMatrixClientContext } from "../contexts/MatrixClientContext";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import { CallEvent, ConnectionState, type ParticipantState } from "../models/Call";

/** Raw participant entry (userId + resolved RoomMember). */
interface RawParticipant {
    userId: string;
    member: RoomMember | null;
}

/** Enriched participant info exposed to consumers. */
export interface VCParticipantInfo {
    userId: string;
    member: RoomMember | null;
    isSpeaking: boolean;
    isMuted: boolean;
    isScreenSharing: boolean;
    isTransitioning: boolean;
}

export interface VCParticipantsResult {
    participants: VCParticipantInfo[];
    connected: boolean;
    /** Timestamp (ms) when the first participant joined the current call, or null if empty */
    callStartedTs: number | null;
}

/**
 * Unified hook that subscribes to MatrixRTC session memberships, the active
 * NexusVoiceConnection, active speakers, and participant states to return
 * an enriched list of VC participants for a room.
 *
 * Replaces the previous combination of useVCParticipants + useNexusActiveSpeakers
 * + useNexusParticipantStates for the sidebar participant list.
 *
 * When connected, reads from NexusVoiceConnection.participants which merges
 * LiveKit (fast path) and MatrixRTC (authoritative) data.
 * When not connected, falls back to session.memberships directly with
 * ghost-participant filtering (isExpired + room membership check).
 */
export function useVCParticipants(roomId: string): VCParticipantsResult {
    const client = useMatrixClientContext();
    const [rawMembers, setRawMembers] = useState<RawParticipant[]>([]);
    const [connected, setConnected] = useState(false);
    const [transitioningIds, setTransitioningIds] = useState<Set<string>>(new Set());
    const [callStartedTs, setCallStartedTs] = useState<number | null>(null);
    const [activeSpeakers, setActiveSpeakers] = useState<Set<string>>(new Set());
    const [participantStates, setParticipantStates] = useState<Map<string, ParticipantState>>(new Map());

    useEffect(() => {
        const room = client.getRoom(roomId);
        if (!room) return;

        const session = client.matrixRTC.getRoomSession(room);
        const myUserId = client.getUserId();

        // ── 参加者リスト更新 ──
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
                const participantList: RawParticipant[] = [];
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
                setRawMembers(participantList);

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

            // 未接続 or 遷移中: session.memberships から読む（ゴースト対策付き）
            const participantList: RawParticipant[] = [];
            const seen = new Set<string>();

            for (const membership of session.memberships) {
                const sender = membership.sender;
                if (!sender || seen.has(sender)) continue;
                // 未接続（かつ遷移中でもない）なら自分は除外
                if (sender === myUserId && !isTransitioning) continue;
                // ゴースト対策: expired チェック
                if (membership.isExpired()) continue;
                // ゴースト対策: ルームから退出済みならスキップ
                const roomMember = room.getMember(sender);
                if (!roomMember || roomMember.membership !== KnownMembership.Join) continue;
                seen.add(sender);
                participantList.push({
                    userId: sender,
                    member: roomMember,
                });
            }

            // 接続中（Connecting）で自分がまだ memberships に出ていない場合も追加
            if (isTransitioning && myUserId && !seen.has(myUserId)) {
                participantList.push({
                    userId: myUserId,
                    member: room.getMember(myUserId),
                });
            }

            setRawMembers(participantList);

            // 未接続時は経過時間を表示しない（stale membership 対策）
            setCallStartedTs(null);
        };

        // ── Active speakers 更新 ──
        const onActiveSpeakers = (speakers: Set<string>): void => {
            setActiveSpeakers(speakers);
        };

        // ── Participant states 更新 ──
        const onParticipantStates = (states: Map<string, ParticipantState>): void => {
            setParticipantStates(new Map(states));
        };

        // ── 全イベントを1箇所で購読 ──
        updateMembers();
        session.on(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);

        // Room state listener: re-resolve RoomMember when member data arrives from /sync
        const roomState = room.currentState;
        // Multiple hook instances (room list, VC view, channel icon) subscribe
        // to the same RoomState — raise the limit to avoid spurious warnings.
        if (roomState.getMaxListeners() < 50) roomState.setMaxListeners(50);
        roomState.on(RoomStateEvent.Members, updateMembers);

        // 接続中は CallEvent.Participants, ConnectionState, ActiveSpeakers, ParticipantStates を購読
        let currentConn = NexusVoiceStore.instance.getConnection(roomId) ?? null;

        const subscribeConn = (conn: typeof currentConn): void => {
            conn?.on(CallEvent.Participants, updateMembers);
            conn?.on(CallEvent.ConnectionState, updateMembers);
            conn?.on(CallEvent.ActiveSpeakers, onActiveSpeakers);
            conn?.on(CallEvent.ParticipantStates, onParticipantStates);
            // Sync initial state from connection
            if (conn) {
                setActiveSpeakers(conn.activeSpeakers);
                setParticipantStates(new Map(conn.participantStates));
            }
        };

        const unsubscribeConn = (conn: typeof currentConn): void => {
            conn?.off(CallEvent.Participants, updateMembers);
            conn?.off(CallEvent.ConnectionState, updateMembers);
            conn?.off(CallEvent.ActiveSpeakers, onActiveSpeakers);
            conn?.off(CallEvent.ParticipantStates, onParticipantStates);
        };

        subscribeConn(currentConn);

        // ActiveConnection が変わったら リスナーを付け替え
        const onConnChange = (): void => {
            unsubscribeConn(currentConn);
            currentConn = NexusVoiceStore.instance.getConnection(roomId) ?? null;
            subscribeConn(currentConn);
            if (!currentConn) {
                setActiveSpeakers(new Set());
                setParticipantStates(new Map());
            }
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

        return () => {
            session.off(MatrixRTCSessionEvent.MembershipsChanged, updateMembers);
            roomState.off(RoomStateEvent.Members, updateMembers);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onConnChange);
            unsubscribeConn(currentConn);
            clearInterval(pollInterval);
        };
    }, [client, roomId]);

    // useMemo で enriched participants を組み立て
    const participants = useMemo(
        () =>
            rawMembers.map(({ userId, member }) => ({
                userId,
                member,
                isSpeaking: activeSpeakers.has(userId),
                isMuted: participantStates.get(userId)?.isMuted ?? false,
                isScreenSharing: participantStates.get(userId)?.isScreenSharing ?? false,
                isTransitioning: transitioningIds.has(userId),
            })),
        [rawMembers, activeSpeakers, participantStates, transitioningIds],
    );

    return { participants, connected, callStartedTs };
}
