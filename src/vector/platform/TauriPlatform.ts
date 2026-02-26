/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import UAParser from "ua-parser-js";
import { logger } from "matrix-js-sdk/src/logger";

import WebPlatform from "./WebPlatform";
import { UpdateCheckStatus, type UpdateStatus } from "../../BasePlatform";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { type CheckUpdatesPayload } from "../../dispatcher/payloads/CheckUpdatesPayload";
import { NexusUpdateStore } from "../../stores/NexusUpdateStore";

const UPDATE_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Platform implementation for Tauri 2 native desktop app.
 * Extends WebPlatform — overrides only what Tauri provides natively:
 *   - App version from tauri.conf.json
 *   - Self-update via tauri-plugin-updater
 *   - No service worker registration (native app doesn't need it)
 */
export default class TauriPlatform extends WebPlatform {
    public async getAppVersion(): Promise<string> {
        const { getVersion } = await import("@tauri-apps/api/app");
        return getVersion();
    }

    public getHumanReadableName(): string {
        return "Tauri Platform";
    }

    public getDefaultDeviceDisplayName(): string {
        const appName = "Nexus Desktop";
        const ua = new UAParser();
        let osName = ua.getOS().name || "unknown OS";
        if (osName === "Mac OS") osName = "macOS";
        return `${appName} on ${osName}`;
    }

    public async canSelfUpdate(): Promise<boolean> {
        return true;
    }

    public startUpdater(): void {
        logger.log("TauriPlatform: starting updater");
        // Check immediately on startup
        void this.checkForTauriUpdate();
        // Poll periodically
        setInterval(() => {
            void this.checkForTauriUpdate();
        }, UPDATE_POLL_INTERVAL_MS);
    }

    public startUpdateCheck(): void {
        super.startUpdateCheck();
        void this.checkForTauriUpdate().then((updateState) => {
            dis.dispatch<CheckUpdatesPayload>({
                action: Action.CheckUpdates,
                ...updateState,
            });
        });
    }

    public installUpdate(): void {
        // Trigger a fresh check + install flow
        void this.performTauriUpdate();
    }

    private async checkForTauriUpdate(): Promise<UpdateStatus> {
        try {
            const { check } = await import("@tauri-apps/plugin-updater");
            const update = await check();

            if (update) {
                const currentVersion = await this.getAppVersion();
                logger.log(`TauriPlatform: update available: ${update.version} (current: ${currentVersion})`);
                NexusUpdateStore.instance.setUpdateAvailable(update.version);
                return { status: UpdateCheckStatus.Ready };
            }

            logger.log("TauriPlatform: no update available");
            return { status: UpdateCheckStatus.NotAvailable };
        } catch (e) {
            logger.error("TauriPlatform: update check failed", e);
            return {
                status: UpdateCheckStatus.Error,
                detail: e instanceof Error ? e.message : String(e),
            };
        }
    }

    private async performTauriUpdate(): Promise<void> {
        const store = NexusUpdateStore.instance;
        try {
            const { check } = await import("@tauri-apps/plugin-updater");
            const { relaunch } = await import("@tauri-apps/plugin-process");

            const update = await check();
            if (!update) {
                logger.log("TauriPlatform: no update to install");
                return;
            }

            logger.log(`TauriPlatform: downloading update ${update.version}...`);
            await update.downloadAndInstall((event) => {
                switch (event.event) {
                    case "Started":
                        store.setDownloadStarted(event.data.contentLength ?? 0);
                        break;
                    case "Progress":
                        store.addDownloadProgress(event.data.chunkLength);
                        break;
                    case "Finished":
                        store.setInstalling();
                        break;
                }
            });
            logger.log("TauriPlatform: update installed, relaunching...");
            await relaunch();
        } catch (e) {
            logger.error("TauriPlatform: failed to install update", e);
            store.setError();
        }
    }
}
