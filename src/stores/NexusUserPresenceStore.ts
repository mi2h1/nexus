/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { corsFreePost, corsFreePut } from "../utils/tauriHttp";
import { NEXUS_JWT_SERVICE_URL } from "../models/NexusVoiceConnection";

export type NexusPresenceStatus = "online" | "unavailable" | "offline";

export enum NexusUserPresenceStoreEvent {
    PresencesChanged = "presences_changed",
}

type NexusUserPresenceStoreEventHandlerMap = {
    [NexusUserPresenceStoreEvent.PresencesChanged]: () => void;
};

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Singleton store for user presence status.
 * Presence is stored on the lk-jwt-service and distributed via SSE.
 * Heartbeat keeps the session alive; sendBeacon fires on page close.
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
    private myPresence: NexusPresenceStatus = "offline";
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    // Cached for use in sendBeacon (async token fetch not possible in pagehide)
    private cachedOpenIdToken: {
        access_token: string;
        token_type: string;
        matrix_server_name: string;
        expires_in: number;
    } | null = null;

    private constructor() {
        super();
    }

    /**
     * Get the presence status for a user. Defaults to "offline" if unknown (never set).
     */
    public getPresence(userId: string): NexusPresenceStatus {
        return this.presences.get(userId) ?? "offline";
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
        // 起動時に自動でオンラインにセット
        this.setMyPresence("online").catch(() => {});
        this.startHeartbeat();
        window.addEventListener("pagehide", this.onPageHide);
    }

    public stop(): void {
        this.eventSource?.close();
        this.eventSource = null;
        if (this.heartbeatTimer !== null) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        window.removeEventListener("pagehide", this.onPageHide);
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
                    this.myPresence = this.presences.get(myId) ?? "offline";
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

    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat().catch(() => {});
        }, HEARTBEAT_INTERVAL_MS);
    }

    private async sendHeartbeat(): Promise<void> {
        if (!this.client) return;
        try {
            const token = await this.client.getOpenIdToken();
            this.cachedOpenIdToken = token;
            await corsFreePost<{ status: string }>(`${NEXUS_JWT_SERVICE_URL}/user-presence-heartbeat`, {
                openid_token: {
                    access_token: token.access_token,
                    token_type: token.token_type,
                    matrix_server_name: token.matrix_server_name,
                    expires_in: token.expires_in,
                },
            });
        } catch (e) {
            logger.warn("NexusUserPresenceStore: heartbeat failed", e);
        }
    }

    // sendBeacon: text/plain body → no CORS preflight → always delivered on page close
    private onPageHide = (): void => {
        if (!this.cachedOpenIdToken) return;
        const body = JSON.stringify({ openid_token: this.cachedOpenIdToken });
        navigator.sendBeacon(
            `${NEXUS_JWT_SERVICE_URL}/user-presence-offline`,
            new Blob([body], { type: "text/plain" }),
        );
    };

    /**
     * Set the current user's presence status.
     */
    public async setMyPresence(status: NexusPresenceStatus): Promise<void> {
        if (!this.client) throw new Error("NexusUserPresenceStore not started");

        const openIdToken = await this.client.getOpenIdToken();
        this.cachedOpenIdToken = openIdToken;

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
