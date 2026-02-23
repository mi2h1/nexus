/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect } from "react";

import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";
import { CallEvent, type ScreenShareInfo } from "../models/Call";

/**
 * Hook that returns screen share info for a specific room.
 * Subscribes to the NexusVoiceConnection for the given room ID.
 */
export function useNexusScreenShares(roomId: string): ScreenShareInfo[] {
    const [screenShares, setScreenShares] = useState<ScreenShareInfo[]>([]);
    const [connection, setConnection] = useState<NexusVoiceConnection | null>(
        () => NexusVoiceStore.instance.getConnection(roomId),
    );

    // Track connection changes
    useEffect(() => {
        const onActiveConnection = (): void => {
            setConnection(NexusVoiceStore.instance.getConnection(roomId));
        };

        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        // Re-check in case connection changed between render and effect
        setConnection(NexusVoiceStore.instance.getConnection(roomId));

        return () => {
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, [roomId]);

    // Subscribe to screen share events from the connection
    useEffect(() => {
        if (!connection) {
            setScreenShares([]);
            return;
        }

        const onScreenShares = (shares: ScreenShareInfo[]): void => {
            setScreenShares(shares);
        };

        connection.on(CallEvent.ScreenShares, onScreenShares);
        // Initial read
        setScreenShares(connection.screenShares);

        return () => {
            connection.off(CallEvent.ScreenShares, onScreenShares);
        };
    }, [connection]);

    return screenShares;
}
