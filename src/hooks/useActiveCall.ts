/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useCallback } from "react";

import { type Call } from "../models/Call";
import { useEventEmitterState } from "./useEventEmitter";
import { CallStore, CallStoreEvent } from "../stores/CallStore";

/**
 * Returns the currently connected call, or null if not in a call.
 * Reactively updates when the connected calls set changes.
 */
export const useActiveCall = (): Call | null => {
    return useEventEmitterState(CallStore.instance, CallStoreEvent.ConnectedCalls, useCallback(
        () => {
            const calls = CallStore.instance.connectedCalls;
            return calls.size > 0 ? [...calls][0] : null;
        },
        [],
    ));
};
