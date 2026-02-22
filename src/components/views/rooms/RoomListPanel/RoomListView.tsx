/*
 * Copyright 2025 New Vector Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { useCallback, type JSX, type ReactNode } from "react";
import { useCreateAutoDisposedViewModel, type Room as SharedRoom } from "@element-hq/web-shared-components";
import { type Room } from "matrix-js-sdk/src/matrix";

import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { RoomAvatarView } from "../../avatars/RoomAvatarView";
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

    // Render avatar for each room - memoized to prevent re-renders
    const renderAvatar = useCallback((room: SharedRoom): ReactNode => {
        return <RoomAvatarView room={room as Room} />;
    }, []);

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

    return <NexusChannelListView vm={vm} renderAvatar={renderAvatar} onKeyDown={onKeyDown} />;
}
