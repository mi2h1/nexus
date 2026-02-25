/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import {
    type MatrixRTCSession,
    MatrixRTCSessionManagerEvents,
    MatrixRTCSessionEvent,
    type Transport,
} from "matrix-js-sdk/src/matrixrtc";
import { MatrixError, type EmptyObject, type Room } from "matrix-js-sdk/src/matrix";

import defaultDispatcher from "../dispatcher/dispatcher";
import { UPDATE_EVENT } from "./AsyncStore";
import { AsyncStoreWithClient } from "./AsyncStoreWithClient";
import WidgetStore from "./WidgetStore";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import { Call, CallEvent, ConnectionState } from "../models/Call";
import type { NexusVoiceConnection } from "../models/NexusVoiceConnection";

export enum CallStoreEvent {
    // Signals a change in the call associated with a given room
    Call = "call",
    // Signals a change in the active calls
    ConnectedCalls = "connected_calls",
    // Signals a change in the configured RTC transports.
    TransportsUpdated = "transports_updated",
}

export class CallStore extends AsyncStoreWithClient<EmptyObject> {
    private static _instance: CallStore;
    public static get instance(): CallStore {
        if (!this._instance) {
            this._instance = new CallStore();
            this._instance.start();
        }
        return this._instance;
    }

    private readonly configuredMatrixRTCTransports = new Set<Transport>();

    private constructor() {
        super(defaultDispatcher);
        this.setMaxListeners(100); // One for each RoomTile
    }

    protected async onAction(): Promise<void> {
        // nothing to do
    }

    /**
     * Fetch transports used by MatrixRTC services, such as Element Call.
     * This function is called once during Store startup which means we don't refetch
     * transports every time we need to check for Element Call support.
     */
    protected async fetchTransports(): Promise<void> {
        if (!this.matrixClient) return;
        this.configuredMatrixRTCTransports.clear();
        // Prefer checking the proper endpoint for transports.
        try {
            const transports = await this.matrixClient._unstable_getRTCTransports();
            transports.forEach((t) => this.configuredMatrixRTCTransports.add(t));
        } catch (ex) {
            // Expected, MSC not implemented.
            if (ex instanceof MatrixError === false || ex.errcode !== "M_NOT_FOUND") {
                logger.warn("Unexpected error when trying to fetch RTC transports", ex);
            }
        }
        // See https://github.com/matrix-org/matrix-spec-proposals/blob/d61969a9a3696b6c54d7987b1643b5bc03670927/proposals/4143-matrix-rtc.md#discovery-of-foci-using-well-knownmatrixclient
        // This well-known option has since been removed from the spec but is still widely deployed.
        await this.matrixClient.waitForClientWellKnown();
        const foci = this.matrixClient.getClientWellKnown()?.["org.matrix.msc4143.rtc_foci"];
        if (Array.isArray(foci)) {
            foci.forEach((foci) => this.configuredMatrixRTCTransports.add(foci));
        }
        this.emit(CallStoreEvent.TransportsUpdated);
    }

    protected async onReady(): Promise<any> {
        if (!this.matrixClient) return;
        // Fetch transports, but don't await the result.
        void this.fetchTransports();
        // We assume that the calls present in a room are a function of room
        // widgets and group calls, so we initialize the room map here and then
        // update it whenever those change
        for (const room of this.matrixClient.getRooms()) {
            this.updateRoom(room);
        }
        this.matrixClient.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionStarted, this.onRTCSessionStart);
        WidgetStore.instance.on(UPDATE_EVENT, this.onWidgets);

        // If the room ID of a previously connected call is still in settings at
        // this time, that's a sign that we failed to disconnect from it
        // properly, and need to clean up after ourselves
        const uncleanlyDisconnectedRoomIds = SettingsStore.getValue("activeCallRoomIds");
        if (uncleanlyDisconnectedRoomIds.length) {
            await Promise.all([
                ...uncleanlyDisconnectedRoomIds.map(async (uncleanlyDisconnectedRoomId): Promise<void> => {
                    logger.log(`Cleaning up call state for room ${uncleanlyDisconnectedRoomId}`);
                    await this.getCall(uncleanlyDisconnectedRoomId)?.clean();
                }),
                SettingsStore.setValue("activeCallRoomIds", null, SettingLevel.DEVICE, []),
            ]);
        }

        // Nexus: Clean up stale MatrixRTC memberships from our own device.
        // This handles unclean disconnects (browser refresh/close while in VC)
        // where activeCallRoomIds may already have been cleared synchronously.
        await this.cleanupStaleMatrixRTCMemberships();

        // Nexus: Session membership calculation is async — the initial cleanup
        // above may run before memberships are populated.  Listen for membership
        // changes on every future session so we can catch stale memberships that
        // appear after the first pass.
        this.matrixClient.matrixRTC.on(
            MatrixRTCSessionManagerEvents.SessionStarted,
            this.onRTCSessionStartForCleanup,
        );
        for (const room of this.matrixClient.getRooms()) {
            const session = this.matrixClient.matrixRTC.getRoomSession(room);
            session.on(MatrixRTCSessionEvent.MembershipsChanged, this.onMembershipsChangedForCleanup);
        }
    }

    protected async onNotReady(): Promise<any> {
        for (const [call, listenerMap] of this.callListeners) {
            // It's important that we remove the listeners before destroying the
            // call, because otherwise the call's onDestroy callback would fire
            // and immediately repopulate the map
            for (const [event, listener] of listenerMap) call.off(event, listener);
            call.destroy();
        }
        this.callListeners.clear();
        this.calls.clear();
        this._connectedCalls.clear();
        this.configuredMatrixRTCTransports.clear();

        this.matrixClient?.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionStarted, this.onRTCSessionStart);
        this.matrixClient?.matrixRTC.off(
            MatrixRTCSessionManagerEvents.SessionStarted,
            this.onRTCSessionStartForCleanup,
        );
        WidgetStore.instance.off(UPDATE_EVENT, this.onWidgets);
    }

    private _connectedCalls: Set<Call | NexusVoiceConnection> = new Set();
    /**
     * The calls to which the user is currently connected.
     */
    public get connectedCalls(): Set<Call | NexusVoiceConnection> {
        return this._connectedCalls;
    }
    private set connectedCalls(value: Set<Call | NexusVoiceConnection>) {
        this._connectedCalls = value;
        this.emit(CallStoreEvent.ConnectedCalls, value);

        // The room IDs are persisted to settings so we can detect unclean disconnects
        SettingsStore.setValue(
            "activeCallRoomIds",
            null,
            SettingLevel.DEVICE,
            [...value].map((call) => call.roomId),
        );
    }

    private calls = new Map<string, Call>(); // Key is room ID
    private callListeners = new Map<Call, Map<CallEvent, (...args: unknown[]) => unknown>>();

    private inUpdateRoom = false;
    private updateRoom(room: Room): void {
        // Nexus: Voice channel rooms (isCallRoom) are managed by
        // NexusVoiceConnection, not ElementCall. Skip them here to prevent
        // an unwanted ElementCall from being created, which would show a
        // call indicator icon even when the user is not in the VC.
        if (room.isCallRoom()) return;

        // XXX: This method is guarded with the flag this.inUpdateRoom because
        // we need to block this method from calling itself recursively. That
        // could happen, for instance, if Call.get adds a new virtual widget to
        // the WidgetStore, firing a WidgetStore update that we don't actually
        // care about. Without the guard we could get duplicate Call objects
        // fighting for control over the same widget.
        if (!this.inUpdateRoom && !this.calls.has(room.roomId)) {
            this.inUpdateRoom = true;
            const call = Call.get(room);

            if (call) {
                const onConnectionState = (state: ConnectionState): void => {
                    if (state === ConnectionState.Connected) {
                        this.connectedCalls = new Set([...this.connectedCalls, call]);
                    } else if (state === ConnectionState.Disconnected) {
                        this.connectedCalls = new Set([...this.connectedCalls].filter((c) => c !== call));
                    }
                };
                const onDestroy = (): void => {
                    this.calls.delete(room.roomId);
                    for (const [event, listener] of this.callListeners.get(call)!) call.off(event, listener);
                    this.updateRoom(room);
                };

                call.on(CallEvent.ConnectionState, onConnectionState);
                call.on(CallEvent.Destroy, onDestroy);

                this.calls.set(room.roomId, call);
                this.callListeners.set(
                    call,
                    new Map<CallEvent, (...args: any[]) => unknown>([
                        [CallEvent.ConnectionState, onConnectionState],
                        [CallEvent.Destroy, onDestroy],
                    ]),
                );
            }

            this.emit(CallStoreEvent.Call, call, room.roomId);
            this.inUpdateRoom = false;
        }
    }

    private voiceConnections = new Map<string, NexusVoiceConnection>();

    /**
     * Gets the call or voice connection associated with the given room, if any.
     * @param {string} roomId The room's ID.
     * @returns {Call | NexusVoiceConnection | null} The call or voice connection.
     */
    public getCall(roomId: string): Call | NexusVoiceConnection | null {
        return this.voiceConnections.get(roomId) ?? this.calls.get(roomId) ?? null;
    }

    /**
     * Gets the active call associated with the given room, if any.
     * @param roomId The room's ID.
     * @returns The active call.
     */
    public getActiveCall(roomId: string): Call | NexusVoiceConnection | null {
        const call = this.getCall(roomId);
        return call !== null && this.connectedCalls.has(call) ? call : null;
    }

    /**
     * Register a NexusVoiceConnection so it's visible to hooks via getCall().
     */
    public registerVoiceConnection(roomId: string, conn: NexusVoiceConnection): void {
        this.voiceConnections.set(roomId, conn);

        // Add to connectedCalls immediately so the UI shows the status panel
        // while still connecting
        this.connectedCalls = new Set([...this.connectedCalls, conn]);

        const onConnectionState = (state: ConnectionState): void => {
            if (state === ConnectionState.Disconnected) {
                this.connectedCalls = new Set([...this.connectedCalls].filter((c) => c !== conn));
            }
        };
        conn.on(CallEvent.ConnectionState, onConnectionState);

        this.emit(CallStoreEvent.Call, conn, roomId);
    }

    /**
     * Unregister a NexusVoiceConnection.
     */
    public unregisterVoiceConnection(roomId: string): void {
        const conn = this.voiceConnections.get(roomId);
        if (conn) {
            this.voiceConnections.delete(roomId);
            this.connectedCalls = new Set([...this.connectedCalls].filter((c) => c !== conn));
            this.emit(CallStoreEvent.Call, null, roomId);
        }
    }

    private onWidgets = (roomId: string | null): void => {
        if (!this.matrixClient) return;
        if (roomId === null) {
            // This store happened to start before the widget store was done
            // loading all rooms, so we need to initialize each room again
            for (const room of this.matrixClient.getRooms()) {
                this.updateRoom(room);
            }
        } else {
            const room = this.matrixClient.getRoom(roomId);
            // Widget updates can arrive before the room does, empirically
            if (room !== null) this.updateRoom(room);
        }
    };

    public getConfiguredRTCTransports(): Transport[] {
        return [...this.configuredMatrixRTCTransports];
    }

    private onRTCSessionStart = (roomId: string, session: MatrixRTCSession): void => {
        this.updateRoom(session.room);
    };

    /**
     * Nexus: Scan all rooms for stale MatrixRTC memberships from our own device
     * and leave those sessions. This handles unclean disconnects (browser refresh
     * or close while in a VC) where activeCallRoomIds may have already been
     * cleared synchronously by destroy().
     */
    private async cleanupStaleMatrixRTCMemberships(): Promise<void> {
        if (!this.matrixClient) return;

        const myUserId = this.matrixClient.getUserId();
        const myDeviceId = this.matrixClient.getDeviceId();
        if (!myUserId || !myDeviceId) return;

        for (const room of this.matrixClient.getRooms()) {
            const session = this.matrixClient.matrixRTC.getRoomSession(room);
            const myMembership = session.memberships.find(
                (m) => m.sender === myUserId && m.deviceId === myDeviceId,
            );
            if (myMembership) {
                // We have a stale membership — we're not actually connected
                logger.log(`Cleaning up stale MatrixRTC membership in room ${room.roomId}`);
                try {
                    await session.leaveRoomSession(5000);
                } catch (e) {
                    logger.warn(`Failed to clean stale MatrixRTC membership in ${room.roomId}`, e);
                }
            }
        }
    }

    /**
     * Nexus: When a new MatrixRTC session starts after onReady, attach a
     * MembershipsChanged listener so we can catch stale memberships that
     * weren't available during the initial cleanup pass.
     */
    private onRTCSessionStartForCleanup = (_roomId: string, session: MatrixRTCSession): void => {
        session.on(MatrixRTCSessionEvent.MembershipsChanged, this.onMembershipsChangedForCleanup);
    };

    /**
     * Nexus: When any session's memberships change, check whether our own
     * device has a stale membership (i.e. we are listed but not actually
     * connected via NexusVoiceConnection).  If so, leave the session.
     */
    private onMembershipsChangedForCleanup = (): void => {
        if (!this.matrixClient) return;

        const myUserId = this.matrixClient.getUserId();
        const myDeviceId = this.matrixClient.getDeviceId();
        if (!myUserId || !myDeviceId) return;

        for (const room of this.matrixClient.getRooms()) {
            const session = this.matrixClient.matrixRTC.getRoomSession(room);
            // Skip rooms with no memberships to avoid unnecessary work
            if (session.memberships.length === 0) continue;

            const conn = this.voiceConnections.get(room.roomId);
            if (conn?.connected) continue; // Actually connected — not stale

            const myMembership = session.memberships.find(
                (m) => m.sender === myUserId && m.deviceId === myDeviceId,
            );
            if (myMembership) {
                logger.log(`Cleaning up late-detected stale MatrixRTC membership in ${room.roomId}`);
                // Remove the listener first to avoid re-entry
                session.off(MatrixRTCSessionEvent.MembershipsChanged, this.onMembershipsChangedForCleanup);
                session.leaveRoomSession(5000).catch((e) => {
                    logger.warn(`Failed to clean stale MatrixRTC membership in ${room.roomId}`, e);
                });
            }
        }
    };
}
