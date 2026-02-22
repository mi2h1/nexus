/*
 * Copyright 2025 Nexus Contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { useMemo } from "react";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { isVideoRoom } from "../utils/video-rooms";

/**
 * Separates room IDs into text channels and voice channels.
 * Voice channels are rooms created as Video Rooms (RoomType.UnstableCall).
 */
export function useChannelSeparation(
    roomIds: string[],
    matrixClient: MatrixClient,
): { textRoomIds: string[]; voiceRoomIds: string[] } {
    return useMemo(() => {
        const textRoomIds: string[] = [];
        const voiceRoomIds: string[] = [];
        for (const roomId of roomIds) {
            const room = matrixClient.getRoom(roomId);
            if (room && isVideoRoom(room)) {
                voiceRoomIds.push(roomId);
            } else {
                textRoomIds.push(roomId);
            }
        }
        return { textRoomIds, voiceRoomIds };
    }, [roomIds, matrixClient]);
}
