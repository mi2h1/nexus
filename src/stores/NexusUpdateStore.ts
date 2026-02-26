/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

export enum NexusUpdateStoreEvent {
    UpdateAvailable = "updateAvailable",
    UpdateProgress = "updateProgress",
}

export enum UpdatePhase {
    None = "none",
    Downloading = "downloading",
    Installing = "installing",
    Error = "error",
}

type EventHandlerMap = {
    [NexusUpdateStoreEvent.UpdateAvailable]: (available: boolean) => void;
    [NexusUpdateStoreEvent.UpdateProgress]: () => void;
};

/**
 * Tiny store that tracks whether a Tauri app update is available
 * and update download/install progress.
 * Written by TauriPlatform, read by NexusUserPanel / NexusUpdateModal.
 */
class NexusUpdateStore extends TypedEventEmitter<NexusUpdateStoreEvent, EventHandlerMap> {
    private static _instance: NexusUpdateStore;

    public static get instance(): NexusUpdateStore {
        if (!this._instance) this._instance = new NexusUpdateStore();
        return this._instance;
    }

    private _updateAvailable = false;
    private _updateVersion = "";
    private _phase = UpdatePhase.None;
    private _downloadedBytes = 0;
    private _totalBytes = 0;

    public get updateAvailable(): boolean {
        return this._updateAvailable;
    }

    public get updateVersion(): string {
        return this._updateVersion;
    }

    public get phase(): UpdatePhase {
        return this._phase;
    }

    public get downloadedBytes(): number {
        return this._downloadedBytes;
    }

    public get totalBytes(): number {
        return this._totalBytes;
    }

    public get progressPercent(): number {
        if (this._totalBytes <= 0) return 0;
        return Math.min(100, Math.round((this._downloadedBytes / this._totalBytes) * 100));
    }

    public setUpdateAvailable(version: string): void {
        this._updateAvailable = true;
        this._updateVersion = version;
        this.emit(NexusUpdateStoreEvent.UpdateAvailable, true);
    }

    public clearUpdate(): void {
        this._updateAvailable = false;
        this._updateVersion = "";
        this._phase = UpdatePhase.None;
        this._downloadedBytes = 0;
        this._totalBytes = 0;
        this.emit(NexusUpdateStoreEvent.UpdateAvailable, false);
    }

    public setDownloadStarted(totalBytes: number): void {
        this._phase = UpdatePhase.Downloading;
        this._totalBytes = totalBytes;
        this._downloadedBytes = 0;
        this.emit(NexusUpdateStoreEvent.UpdateProgress);
    }

    public addDownloadProgress(chunkLength: number): void {
        this._downloadedBytes += chunkLength;
        this.emit(NexusUpdateStoreEvent.UpdateProgress);
    }

    public setInstalling(): void {
        this._phase = UpdatePhase.Installing;
        this.emit(NexusUpdateStoreEvent.UpdateProgress);
    }

    public setError(): void {
        this._phase = UpdatePhase.Error;
        this.emit(NexusUpdateStoreEvent.UpdateProgress);
    }
}

export { NexusUpdateStore };
