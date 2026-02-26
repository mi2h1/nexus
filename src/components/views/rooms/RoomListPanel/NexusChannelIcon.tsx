/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useState, useEffect, type JSX } from "react";
import VolumeOnSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/volume-on-solid";

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
 * Discord-style speaker icon for voice channels.
 * Green + elapsed time when anyone is in the call, grey otherwise.
 */
export function VoiceChannelIcon({ roomId }: { roomId: string }): JSX.Element {
    const { members, callStartedTs } = useVCParticipants(roomId);
    const hasParticipants = members.length > 0;
    const elapsed = useElapsedTime(hasParticipants ? callStartedTs : null);

    const color = hasParticipants
        ? "var(--cpd-color-icon-success-primary)" // green
        : "var(--cpd-color-icon-tertiary)"; // grey

    return (
        <span className="mx_NexusChannelIcon">
            <VolumeOnSolidIcon width="16px" height="16px" color={color} aria-label="Voice channel" />
            {elapsed && <span className="mx_NexusChannelIcon_elapsed">{elapsed}</span>}
        </span>
    );
}
