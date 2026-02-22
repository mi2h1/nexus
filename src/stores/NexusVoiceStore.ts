/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { NexusVoiceConnection } from "../models/NexusVoiceConnection";
import { CallStore } from "./CallStore";
import { MatrixClientPeg } from "../MatrixClientPeg";

export enum NexusVoiceStoreEvent {
    ActiveConnection = "active_connection",
}

type NexusVoiceStoreEventHandlerMap = {
    [NexusVoiceStoreEvent.ActiveConnection]: (connection: NexusVoiceConnection | null) => void;
};

/**
 * Singleton store managing voice channel connections.
 * Only one voice channel can be connected at a time (like Discord).
 */
export class NexusVoiceStore extends TypedEventEmitter<NexusVoiceStoreEvent, NexusVoiceStoreEventHandlerMap> {
    private static _instance: NexusVoiceStore;
    public static get instance(): NexusVoiceStore {
        if (!this._instance) {
            this._instance = new NexusVoiceStore();
        }
        return this._instance;
    }

    private activeConnection: NexusVoiceConnection | null = null;
    private connections = new Map<string, NexusVoiceConnection>();

    private constructor() {
        super();
    }

    /**
     * Join a voice channel. If already in a VC, disconnect first.
     */
    public async joinVoiceChannel(room: Room): Promise<void> {
        const client = MatrixClientPeg.safeGet();

        // If already in this VC, do nothing
        if (this.activeConnection?.roomId === room.roomId && this.activeConnection.connected) {
            return;
        }

        // Disconnect from current VC if any
        if (this.activeConnection?.connected) {
            await this.leaveVoiceChannel();
        }

        // Get MatrixRTC session and transports
        const session = client.matrixRTC.getRoomSession(room);
        const transports = CallStore.instance.getConfiguredRTCTransports();

        // Create new connection
        const connection = new NexusVoiceConnection(room, client, session, transports);
        this.connections.set(room.roomId, connection);
        this.activeConnection = connection;

        // Register in CallStore
        CallStore.instance.registerVoiceConnection(room.roomId, connection);

        this.emit(NexusVoiceStoreEvent.ActiveConnection, connection);

        try {
            await connection.connect();
        } catch (e) {
            logger.error("Failed to join voice channel", e);
            // Clean up on failure
            CallStore.instance.unregisterVoiceConnection(room.roomId);
            connection.destroy();
            this.connections.delete(room.roomId);
            this.activeConnection = null;
            this.emit(NexusVoiceStoreEvent.ActiveConnection, null);
            throw e;
        }
    }

    /**
     * Leave the currently connected voice channel.
     */
    public async leaveVoiceChannel(): Promise<void> {
        if (!this.activeConnection) return;

        const roomId = this.activeConnection.roomId;
        try {
            await this.activeConnection.disconnect();
        } catch (e) {
            logger.warn("Error disconnecting voice channel", e);
        }

        CallStore.instance.unregisterVoiceConnection(roomId);
        this.activeConnection.destroy();
        this.connections.delete(roomId);
        this.activeConnection = null;
        this.emit(NexusVoiceStoreEvent.ActiveConnection, null);
    }

    /**
     * Get the connection for a specific room, if any.
     */
    public getConnection(roomId: string): NexusVoiceConnection | null {
        return this.connections.get(roomId) ?? null;
    }

    /**
     * Get the currently active connection.
     */
    public getActiveConnection(): NexusVoiceConnection | null {
        return this.activeConnection;
    }
}
