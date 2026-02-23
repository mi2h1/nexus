/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect, useCallback } from "react";

import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";
import { CallEvent, type ScreenShareInfo } from "../models/Call";

interface NexusVoiceState {
    connection: NexusVoiceConnection | null;
    latencyMs: number | null;
    isMicMuted: boolean;
    isScreenSharing: boolean;
    screenShares: ScreenShareInfo[];
}

/**
 * Hook for accessing NexusVoiceConnection-specific data (latency, mic state, screen shares).
 * Polls latency from the active connection.
 */
export function useNexusVoice(): NexusVoiceState {
    const [connection, setConnection] = useState<NexusVoiceConnection | null>(
        () => NexusVoiceStore.instance.getActiveConnection(),
    );
    const [latencyMs, setLatencyMs] = useState<number | null>(null);
    const [isMicMuted, setIsMicMuted] = useState(false);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [screenShares, setScreenShares] = useState<ScreenShareInfo[]>([]);

    const onActiveConnection = useCallback((conn: NexusVoiceConnection | null) => {
        setConnection(conn);
        if (!conn) {
            setLatencyMs(null);
            setIsMicMuted(false);
            setIsScreenSharing(false);
            setScreenShares([]);
        }
    }, []);

    useEffect(() => {
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        return () => {
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, [onActiveConnection]);

    // Poll latency from the connection
    useEffect(() => {
        if (!connection) return;

        const interval = setInterval(() => {
            setLatencyMs(connection.latencyMs);
        }, 2000);

        // Initial read
        setLatencyMs(connection.latencyMs);
        setIsMicMuted(connection.isMicMuted);

        return () => clearInterval(interval);
    }, [connection]);

    // Listen for mic mute changes (instant sync between control bar and user panel)
    useEffect(() => {
        if (!connection) return;

        const onMicMuted = (muted: boolean): void => {
            setIsMicMuted(muted);
        };

        connection.on(CallEvent.MicMuted, onMicMuted);
        setIsMicMuted(connection.isMicMuted);

        return () => {
            connection.off(CallEvent.MicMuted, onMicMuted);
        };
    }, [connection]);

    // Listen for screen share changes
    useEffect(() => {
        if (!connection) return;

        const onScreenShares = (shares: ScreenShareInfo[]): void => {
            setScreenShares(shares);
            setIsScreenSharing(connection.isScreenSharing);
        };

        connection.on(CallEvent.ScreenShares, onScreenShares);

        // Initial read
        setScreenShares(connection.screenShares);
        setIsScreenSharing(connection.isScreenSharing);

        return () => {
            connection.off(CallEvent.ScreenShares, onScreenShares);
        };
    }, [connection]);

    return { connection, latencyMs, isMicMuted, isScreenSharing, screenShares };
}
