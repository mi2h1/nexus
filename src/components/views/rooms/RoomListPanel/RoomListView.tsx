/*
 * Copyright 2025 New Vector Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useCallback, type JSX } from "react";
import { useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { getKeyBindingsManager } from "../../../../KeyBindingsManager";
import { KeyBindingAction } from "../../../../accessibility/KeyboardShortcuts";
import { Landmark, LandmarkNavigation } from "../../../../accessibility/LandmarkNavigation";
import { RoomListViewViewModel } from "../../../../viewmodels/room-list/RoomListViewViewModel";
import { NexusChannelListView } from "./NexusChannelListView";

/**
 * RoomListView component using Nexus channel list with text/voice separation.
 */
export function RoomListView(): JSX.Element {
    const matrixClient = useMatrixClientContext();

    // Create and auto-dispose ViewModel instance
    const vm = useCreateAutoDisposedViewModel(() => new RoomListViewViewModel({ client: matrixClient }));

    // Handle keyboard navigation for landmarks
    const onKeyDown = useCallback((ev: React.KeyboardEvent) => {
        const navAction = getKeyBindingsManager().getNavigationAction(ev);
        if (navAction === KeyBindingAction.NextLandmark || navAction === KeyBindingAction.PreviousLandmark) {
            LandmarkNavigation.findAndFocusNextLandmark(
                Landmark.ROOM_LIST,
                navAction === KeyBindingAction.PreviousLandmark,
            );
            ev.stopPropagation();
            ev.preventDefault();
        }
    }, []);

    return <NexusChannelListView vm={vm} onKeyDown={onKeyDown} />;
}
