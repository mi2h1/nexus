/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useState, useEffect, type JSX } from "react";

import { useVCParticipants } from "../../../../hooks/useVCParticipants";

/**
 * Discord-style "#" icon for text channels.
 */
export function TextChannelIcon(): JSX.Element {
    return (
        <span className="mx_NexusChannelIcon mx_NexusChannelIcon_text" aria-label="Text channel">
            #
        </span>
    );
}

/**
 * Format elapsed milliseconds as "H:MM:SS" or "M:SS".
 */
function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Hook that returns a formatted elapsed-time string updated every second.
 * Returns null when startTs is null.
 */
function useElapsedTime(startTs: number | null): string | null {
    const [elapsed, setElapsed] = useState<string | null>(null);

    useEffect(() => {
        if (startTs === null) {
            setElapsed(null);
            return;
        }

        const update = (): void => {
            const diff = Date.now() - startTs;
            setElapsed(formatElapsed(Math.max(0, diff)));
        };

        update();
        const id = window.setInterval(update, 1000);
        return () => window.clearInterval(id);
    }, [startTs]);

    return elapsed;
}

/**
 * Avatar slot for voice channels.
 * Shows elapsed time when anyone is in the call, empty otherwise.
 */
export function VoiceChannelIcon({ roomId }: { roomId: string }): JSX.Element {
    const { members, callStartedTs } = useVCParticipants(roomId);
    const hasParticipants = members.length > 0;
    const elapsed = useElapsedTime(hasParticipants ? callStartedTs : null);

    return (
        <span className="mx_NexusChannelIcon mx_NexusChannelIcon_elapsed" aria-label="Voice channel">
            {elapsed}
        </span>
    );
}
