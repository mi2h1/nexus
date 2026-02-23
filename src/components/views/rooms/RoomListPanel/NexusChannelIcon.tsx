/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import VolumeOnSolidIcon from "@vector-im/compound-design-tokens/assets/web/icons/volume-on-solid";

import { useCall, useConnectionState } from "../../../../hooks/useCall";
import { ConnectionState } from "../../../../models/Call";

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
 * Discord-style speaker icon for voice channels.
 * Green when a call is connected, grey otherwise.
 */
export function VoiceChannelIcon({ roomId }: { roomId: string }): JSX.Element {
    const call = useCall(roomId);
    const connectionState = useConnectionState(call);
    const isConnected = connectionState === ConnectionState.Connected;
    const color = isConnected
        ? "var(--cpd-color-icon-success-primary)" // green
        : "var(--cpd-color-icon-tertiary)"; // grey

    return (
        <VolumeOnSolidIcon
            className="mx_NexusChannelIcon mx_NexusChannelIcon_voice"
            width="16px"
            height="16px"
            color={color}
            aria-label="Voice channel"
        />
    );
}
