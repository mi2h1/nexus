/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useState, useEffect, type JSX } from "react";

import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../stores/NexusVoiceStore";
import { NexusVCPopout } from "./NexusVCPopout";

/**
 * Persistent container for NexusVCPopout — rendered from LoggedInView
 * so it survives room navigation. When the user navigates away from
 * the VC room, the popout window stays open instead of being unmounted.
 */
export function NexusVCPopoutContainer(): JSX.Element | null {
    const [popoutWindow, setPopoutWindow] = useState<Window | null>(() =>
        NexusVoiceStore.instance.getPopoutWindow(),
    );
    const [roomId, setRoomId] = useState<string | null>(() =>
        NexusVoiceStore.instance.getActiveConnection()?.roomId ?? null,
    );

    useEffect(() => {
        const onPopoutChanged = (win: Window | null): void => setPopoutWindow(win);
        const onActiveConnection = (): void => {
            setRoomId(NexusVoiceStore.instance.getActiveConnection()?.roomId ?? null);
        };
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.PopoutChanged, onPopoutChanged);
        NexusVoiceStore.instance.on(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        return () => {
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.PopoutChanged, onPopoutChanged);
            NexusVoiceStore.instance.off(NexusVoiceStoreEvent.ActiveConnection, onActiveConnection);
        };
    }, []);

    if (!popoutWindow || !roomId) return null;

    return (
        <NexusVCPopout
            roomId={roomId}
            childWindow={popoutWindow}
            onClose={() => NexusVoiceStore.instance.setPopoutWindow(null)}
        />
    );
}
