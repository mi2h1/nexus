/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { corsFreeGet, corsFreePut } from "../utils/tauriHttp";

const JWT_SERVICE_URL = "https://lche2.xvps.jp:7891";

export enum NexusUserColorStoreEvent {
    ColorsChanged = "colors_changed",
}

type NexusUserColorStoreEventHandlerMap = {
    [NexusUserColorStoreEvent.ColorsChanged]: () => void;
};

/**
 * Singleton store for user display name colors.
 * Colors are stored on the lk-jwt-service and shared across all users.
 */
export class NexusUserColorStore extends TypedEventEmitter<
    NexusUserColorStoreEvent,
    NexusUserColorStoreEventHandlerMap
> {
    private static _instance: NexusUserColorStore;
    public static get instance(): NexusUserColorStore {
        if (!this._instance) {
            this._instance = new NexusUserColorStore();
        }
        return this._instance;
    }

    private colors: Map<string, string> = new Map();
    private client: MatrixClient | null = null;

    private constructor() {
        super();
    }

    /**
     * Get the custom color for a user, or undefined if using default.
     */
    public getColor(userId: string): string | undefined {
        return this.colors.get(userId);
    }

    /**
     * Start the store — call once after the client is ready.
     */
    public start(client: MatrixClient): void {
        this.client = client;
        this.fetchColors().catch((e) => {
            logger.warn("NexusUserColorStore: failed to fetch colors", e);
        });
    }

    /**
     * Fetch all user colors from the server.
     */
    public async fetchColors(): Promise<void> {
        try {
            const data = await corsFreeGet<Record<string, string>>(`${JWT_SERVICE_URL}/user-colors`);
            this.colors.clear();
            for (const [userId, color] of Object.entries(data)) {
                this.colors.set(userId, color);
            }
            this.emit(NexusUserColorStoreEvent.ColorsChanged);
        } catch (e) {
            logger.warn("NexusUserColorStore: fetchColors failed", e);
        }
    }

    /**
     * Set the current user's color. Pass empty string to reset to default.
     */
    public async setMyColor(color: string): Promise<void> {
        if (!this.client) {
            throw new Error("NexusUserColorStore not started");
        }

        const openIdToken = await this.client.getOpenIdToken();

        await corsFreePut<{ status: string }>(`${JWT_SERVICE_URL}/user-color`, {
            openid_token: {
                access_token: openIdToken.access_token,
                token_type: openIdToken.token_type,
                matrix_server_name: openIdToken.matrix_server_name,
                expires_in: openIdToken.expires_in,
            },
            color,
        });

        // Update local cache
        const userId = this.client.getSafeUserId();
        if (color) {
            this.colors.set(userId, color);
        } else {
            this.colors.delete(userId);
        }
        this.emit(NexusUserColorStoreEvent.ColorsChanged);
    }
}
