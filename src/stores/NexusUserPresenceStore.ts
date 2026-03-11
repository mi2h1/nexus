/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { corsFreePut } from "../utils/tauriHttp";
import { NEXUS_JWT_SERVICE_URL } from "../models/NexusVoiceConnection";

export type NexusPresenceStatus = "online" | "unavailable" | "offline";

export enum NexusUserPresenceStoreEvent {
    PresencesChanged = "presences_changed",
}

type NexusUserPresenceStoreEventHandlerMap = {
    [NexusUserPresenceStoreEvent.PresencesChanged]: () => void;
};

/**
 * Singleton store for user presence status.
 * Presence is stored on the lk-jwt-service and distributed via SSE.
 */
export class NexusUserPresenceStore extends TypedEventEmitter<
    NexusUserPresenceStoreEvent,
    NexusUserPresenceStoreEventHandlerMap
> {
    private static _instance: NexusUserPresenceStore;
    public static get instance(): NexusUserPresenceStore {
        if (!this._instance) {
            this._instance = new NexusUserPresenceStore();
        }
        return this._instance;
    }

    private presences: Map<string, NexusPresenceStatus> = new Map();
    private client: MatrixClient | null = null;
    private eventSource: EventSource | null = null;
    private myPresence: NexusPresenceStatus = "online";

    private constructor() {
        super();
    }

    /**
     * Get the presence status for a user. Defaults to "online" if unknown.
     */
    public getPresence(userId: string): NexusPresenceStatus {
        return this.presences.get(userId) ?? "online";
    }

    public getMyPresence(): NexusPresenceStatus {
        return this.myPresence;
    }

    /**
     * Start the store — call once after the client is ready.
     */
    public start(client: MatrixClient): void {
        this.client = client;
        this.connectSSE();
    }

    public stop(): void {
        this.eventSource?.close();
        this.eventSource = null;
    }

    private connectSSE(): void {
        this.eventSource?.close();

        const es = new EventSource(`${NEXUS_JWT_SERVICE_URL}/user-presence-stream`);
        this.eventSource = es;

        es.onmessage = (event): void => {
            try {
                const data = JSON.parse(event.data) as Record<string, string>;
                this.presences.clear();
                for (const [userId, status] of Object.entries(data)) {
                    this.presences.set(userId, status as NexusPresenceStatus);
                }
                if (this.client) {
                    const myId = this.client.getSafeUserId();
                    this.myPresence = this.presences.get(myId) ?? "online";
                }
                this.emit(NexusUserPresenceStoreEvent.PresencesChanged);
            } catch (e) {
                logger.warn("NexusUserPresenceStore: failed to parse SSE data", e);
            }
        };

        es.onerror = (): void => {
            logger.warn("NexusUserPresenceStore: SSE connection error, reconnecting in 5s");
            es.close();
            this.eventSource = null;
            setTimeout(() => this.connectSSE(), 5000);
        };
    }

    /**
     * Set the current user's presence status.
     */
    public async setMyPresence(status: NexusPresenceStatus): Promise<void> {
        if (!this.client) throw new Error("NexusUserPresenceStore not started");

        const openIdToken = await this.client.getOpenIdToken();

        await corsFreePut<{ status: string }>(`${NEXUS_JWT_SERVICE_URL}/user-presence`, {
            openid_token: {
                access_token: openIdToken.access_token,
                token_type: openIdToken.token_type,
                matrix_server_name: openIdToken.matrix_server_name,
                expires_in: openIdToken.expires_in,
            },
            status,
        });

        // 楽観的更新（SSEで確定される）
        this.myPresence = status;
        if (this.client) {
            this.presences.set(this.client.getSafeUserId(), status);
        }
        this.emit(NexusUserPresenceStoreEvent.PresencesChanged);
    }
}
