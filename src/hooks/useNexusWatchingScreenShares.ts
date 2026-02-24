/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useState, useEffect } from "react";

import { NexusVoiceStore, NexusVoiceStoreEvent } from "../stores/NexusVoiceStore";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";
import { CallEvent } from "../models/Call";

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Hook that returns the set of screen share participant identities
 * currently being watched. Subscribes to WatchingChanged events on the
 * active NexusVoiceConnection so watching state persists across room
 * navigation (the source of truth lives in NexusVoiceConnection, not
 * in component-local useState).
 */
export function useNexusWatchingScreenShares(): ReadonlySet<string> {
    const [connection, setConnection] = useState<NexusVoiceConnection | null>(
        () => NexusVoiceStore.instance.getActiveConnection(),
    );
    const [watchingIds, setWatchingIds] = useState<ReadonlySet<string>>(
        () => NexusVoiceStore.instance.getActiveConnection()?.watchingScreenShareIds ?? EMPTY_SET,
    );

    // Track active connection changes
    useEffect(() => {
        const onActiveConnection = (conn: NexusVoiceConnection | null): void => {
            setConnection(conn);
            setWatchingIds(conn?.watchingScreenShareIds ?? EMPTY_SET);
        };

        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        // Re-check in case connection changed between render and effect
        const current = NexusVoiceStore.instance.getActiveConnection();
        setConnection(current);
        setWatchingIds(current?.watchingScreenShareIds ?? EMPTY_SET);

        return () => {
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, []);

    // Subscribe to WatchingChanged events from the connection
    useEffect(() => {
        if (!connection) {
            setWatchingIds(EMPTY_SET);
            return;
        }

        const onWatchingChanged = (ids: ReadonlySet<string>): void => {
            setWatchingIds(ids);
        };

        connection.on(CallEvent.WatchingChanged, onWatchingChanged);
        // Initial read
        setWatchingIds(connection.watchingScreenShareIds);

        return () => {
            connection.off(CallEvent.WatchingChanged, onWatchingChanged);
        };
    }, [connection]);

    return watchingIds;
}
