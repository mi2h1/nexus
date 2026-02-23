/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect } from "react";

import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";
import { CallEvent, type ParticipantState } from "../models/Call";

/**
 * Hook returning per-participant mute / screen-share status (keyed by Matrix userId).
 * Subscribes to the active NexusVoiceConnection's ParticipantStates event.
 */
export function useNexusParticipantStates(): Map<string, ParticipantState> {
    const [states, setStates] = useState<Map<string, ParticipantState>>(() => {
        const conn = NexusVoiceStore.instance.getActiveConnection();
        return conn?.participantStates ?? new Map();
    });

    useEffect(() => {
        let conn: NexusVoiceConnection | null = NexusVoiceStore.instance.getActiveConnection();

        const onParticipantStates = (newStates: Map<string, ParticipantState>): void => {
            setStates(new Map(newStates));
        };

        const subscribe = (c: NexusVoiceConnection | null): void => {
            if (conn) conn.off(CallEvent.ParticipantStates, onParticipantStates);
            conn = c;
            if (conn) {
                conn.on(CallEvent.ParticipantStates, onParticipantStates);
                setStates(new Map(conn.participantStates));
            } else {
                setStates(new Map());
            }
        };

        const onActiveConnection = (c: NexusVoiceConnection | null): void => subscribe(c);

        // Initial subscribe
        if (conn) conn.on(CallEvent.ParticipantStates, onParticipantStates);
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);

        return () => {
            if (conn) conn.off(CallEvent.ParticipantStates, onParticipantStates);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, []);

    return states;
}
