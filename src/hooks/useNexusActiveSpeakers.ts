/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect } from "react";

import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";
import { CallEvent } from "../models/Call";

const EMPTY_SET = new Set<string>();

/**
 * Hook that returns the set of currently speaking participant identities
 * for the active voice connection.
 *
 * Identity is the LiveKit participant identity (typically Matrix user ID).
 */
export function useNexusActiveSpeakers(): Set<string> {
    const [activeSpeakers, setActiveSpeakers] = useState<Set<string>>(EMPTY_SET);
    const [connection, setConnection] = useState<NexusVoiceConnection | null>(
        () => NexusVoiceStore.instance.getActiveConnection(),
    );

    useEffect(() => {
        const onActiveConnection = (conn: NexusVoiceConnection | null): void => {
            setConnection(conn);
            if (!conn) setActiveSpeakers(EMPTY_SET);
        };
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        return () => {
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, []);

    useEffect(() => {
        if (!connection) return;

        const onSpeakers = (speakers: Set<string>): void => {
            setActiveSpeakers(speakers);
        };

        connection.on(CallEvent.ActiveSpeakers, onSpeakers);
        setActiveSpeakers(connection.activeSpeakers);

        return () => {
            connection.off(CallEvent.ActiveSpeakers, onSpeakers);
        };
    }, [connection]);

    return activeSpeakers;
}
