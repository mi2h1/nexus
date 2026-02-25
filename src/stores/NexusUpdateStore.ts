/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

export enum NexusUpdateStoreEvent {
    UpdateAvailable = "updateAvailable",
}

type EventHandlerMap = {
    [NexusUpdateStoreEvent.UpdateAvailable]: (available: boolean) => void;
};

/**
 * Tiny store that tracks whether a Tauri app update is available.
 * Written by TauriPlatform, read by NexusUserPanel.
 */
class NexusUpdateStore extends TypedEventEmitter<NexusUpdateStoreEvent, EventHandlerMap> {
    private static _instance: NexusUpdateStore;

    public static get instance(): NexusUpdateStore {
        if (!this._instance) this._instance = new NexusUpdateStore();
        return this._instance;
    }

    private _updateAvailable = false;
    private _updateVersion = "";

    public get updateAvailable(): boolean {
        return this._updateAvailable;
    }

    public get updateVersion(): string {
        return this._updateVersion;
    }

    public setUpdateAvailable(version: string): void {
        this._updateAvailable = true;
        this._updateVersion = version;
        this.emit(NexusUpdateStoreEvent.UpdateAvailable, true);
    }

    public clearUpdate(): void {
        this._updateAvailable = false;
        this._updateVersion = "";
        this.emit(NexusUpdateStoreEvent.UpdateAvailable, false);
    }
}

export { NexusUpdateStore };
