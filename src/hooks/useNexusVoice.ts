/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect, useCallback } from "react";

import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";

interface NexusVoiceState {
    connection: NexusVoiceConnection | null;
    latencyMs: number | null;
    isMicMuted: boolean;
}

/**
 * Hook for accessing NexusVoiceConnection-specific data (latency, mic state).
 * Polls latency from the active connection.
 */
export function useNexusVoice(): NexusVoiceState {
    const [connection, setConnection] = useState<NexusVoiceConnection | null>(
        () => NexusVoiceStore.instance.getActiveConnection(),
    );
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [isMicMuted, setIsMicMuted] = useState(false);

    const onActiveConnection = useCallback((conn: NexusVoiceConnection | null) => {
        setConnection(conn);
        if (!conn) {
            setLatencyMs(null);
            setIsMicMuted(false);
        }
    }, []);

    useEffect(() => {
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        return () => {
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, [onActiveConnection]);

    // Poll latency and mic state from the connection
    useEffect(() => {
        if (!connection) return;

        const interval = setInterval(() => {
            setLatencyMs(connection.latencyMs);
            setIsMicMuted(connection.isMicMuted);
        }, 2000);

        // Initial read
        setLatencyMs(connection.latencyMs);
        setIsMicMuted(connection.isMicMuted);

        return () => clearInterval(interval);
    }, [connection]);

    return { connection, latencyMs, isMicMuted };
}
