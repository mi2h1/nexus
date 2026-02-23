/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { type Room } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { NexusVoiceConnection, playVcSound, VC_STANDBY_SOUND, VC_LEAVE_SOUND, VC_MUTE_SOUND, VC_UNMUTE_SOUND } from "../models/NexusVoiceConnection";
import { CallStore } from "./CallStore";
import { MatrixClientPeg } from "../MatrixClientPeg";

export enum NexusVoiceStoreEvent {
    ActiveConnection = "active_connection",
    PreMicMuted = "pre_mic_muted",
}

type NexusVoiceStoreEventHandlerMap = {
    [NexusVoiceStoreEvent.ActiveConnection]: (connection: NexusVoiceConnection | null) => void;
    [NexusVoiceStoreEvent.PreMicMuted]: (muted: boolean) => void;
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
    private _preMicMuted = false;

    private constructor() {
        super();
    }

    /**
     * Whether the mic is pre-muted (before joining a VC).
     */
    public get preMicMuted(): boolean {
        return this._preMicMuted;
    }

    /**
     * Toggle mic mute. Works both in and out of a VC.
     * When not in a VC, stores the mute state for the next join.
     */
    public toggleMic(): void {
        if (this.activeConnection) {
            const newMuted = !this.activeConnection.isMicMuted;
            this.activeConnection.setMicMuted(newMuted);
            playVcSound(newMuted ? VC_MUTE_SOUND : VC_UNMUTE_SOUND);
        } else {
            this._preMicMuted = !this._preMicMuted;
            playVcSound(this._preMicMuted ? VC_MUTE_SOUND : VC_UNMUTE_SOUND);
            this.emit(NexusVoiceStoreEvent.PreMicMuted, this._preMicMuted);
        }
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

        // Play standby SE when connection starts (join SE plays on membership change)
        playVcSound(VC_STANDBY_SOUND);

        // Register in CallStore
        CallStore.instance.registerVoiceConnection(room.roomId, connection);

        this.emit(NexusVoiceStoreEvent.ActiveConnection, connection);

        try {
            await connection.connect();
            // Apply pre-mute state after connection is established
            if (this._preMicMuted) {
                connection.setMicMuted(true);
            }
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

        const connection = this.activeConnection;
        const roomId = connection.roomId;

        // Play leave SE immediately for instant feedback
        playVcSound(VC_LEAVE_SOUND);

        // Clear state immediately so UI updates right away
        CallStore.instance.unregisterVoiceConnection(roomId);
        this.connections.delete(roomId);
        this.activeConnection = null;
        this.emit(NexusVoiceStoreEvent.ActiveConnection, null);

        // Background disconnect (MatrixRTC leave + LiveKit cleanup)
        connection.disconnect().catch((e) => {
            logger.warn("Background disconnect error", e);
        }).finally(() => {
            connection.destroy();
        });
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
