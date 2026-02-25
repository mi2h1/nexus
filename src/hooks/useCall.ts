/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useCallback, useMemo, useEffect } from "react";

import type { RoomMember } from "matrix-js-sdk/src/matrix";
import { type Call, ConnectionState, CallEvent } from "../models/Call";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";
import { useTypedEventEmitterState, useEventEmitter } from "./useEventEmitter";
import { CallStore, CallStoreEvent } from "../stores/CallStore";
import { MatrixClientPeg } from "../MatrixClientPeg";

export const useCall = (roomId: string): Call | NexusVoiceConnection | null => {
    const [call, setCall] = useState(() => CallStore.instance.getCall(roomId));
    useEventEmitter(
        CallStore.instance,
        CallStoreEvent.Call,
        (call: Call | NexusVoiceConnection | null, forRoomId: string) => {
            if (forRoomId === roomId) setCall(call);
        },
    );

    // Reset the value when the roomId changes
    useEffect(() => {
        setCall(CallStore.instance.getCall(roomId));
    }, [roomId]);

    return call;
};

export const useCallForWidget = (widgetId: string, roomId: string): Call | null => {
    const call = useCall(roomId);
    // NexusVoiceConnection has no widget, so only match against Call instances
    if (call && "widget" in call && call.widget.id === widgetId) return call as Call;
    return null;
};

export const useConnectionState = (call: Call | NexusVoiceConnection | null): ConnectionState =>
    useTypedEventEmitterState(
        call ?? undefined,
        CallEvent.ConnectionState,
        useCallback((state) => state ?? call?.connectionState ?? ConnectionState.Disconnected, [call]),
    );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const useParticipants = (call: Call | NexusVoiceConnection | null): Map<any, Set<string>> => {
    return useTypedEventEmitterState(
        call ?? undefined,
        CallEvent.Participants,
        useCallback((state) => state ?? call?.participants ?? new Map(), [call]),
    );
};

export const useParticipantCount = (call: Call | NexusVoiceConnection | null): number => {
    const participants = useParticipants(call);

    return useMemo(() => {
        return [...participants.values()].reduce<number>((count, set) => count + set.size, 0);
    }, [participants]);
};

export const useParticipatingMembers = (call: Call | NexusVoiceConnection): RoomMember[] => {
    const participants = useParticipants(call);

    return useMemo(() => {
        const members: RoomMember[] = [];
        const room = MatrixClientPeg.get()?.getRoom(call.roomId);

        for (const [key, devices] of participants) {
            // Key is RoomMember (from Call) or userId string (from NexusVoiceConnection)
            let member: RoomMember | null;
            if (typeof key === "string") {
                member = room?.getMember(key) ?? null;
            } else {
                member = key;
            }
            if (member) {
                for (let i = 0; i < devices.size; i++) members.push(member);
            }
        }
        return members;
    }, [participants, call.roomId]);
};
