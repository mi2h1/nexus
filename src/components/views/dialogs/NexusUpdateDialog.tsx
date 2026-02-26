/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, type JSX } from "react";

import BaseDialog from "./BaseDialog";
import { NexusUpdateStore, NexusUpdateStoreEvent, UpdatePhase } from "../../../stores/NexusUpdateStore";
import { useEventEmitterState } from "../../../hooks/useEventEmitter";

interface Props {
    onFinished: () => void;
}

/**
 * Modal dialog shown during Tauri app update download & install.
 * Cannot be dismissed while the update is in progress.
 */
export default function NexusUpdateDialog({ onFinished }: Props): JSX.Element {
    const store = NexusUpdateStore.instance;

    const phase = useEventEmitterState(
        store,
        NexusUpdateStoreEvent.UpdateProgress,
        useCallback(() => store.phase, [store]),
    );

    const percent = useEventEmitterState(
        store,
        NexusUpdateStoreEvent.UpdateProgress,
        useCallback(() => store.progressPercent, [store]),
    );

    const totalBytes = useEventEmitterState(
        store,
        NexusUpdateStoreEvent.UpdateProgress,
        useCallback(() => store.totalBytes, [store]),
    );

    const downloadedBytes = useEventEmitterState(
        store,
        NexusUpdateStoreEvent.UpdateProgress,
        useCallback(() => store.downloadedBytes, [store]),
    );

    const isError = phase === UpdatePhase.Error;
    const isInstalling = phase === UpdatePhase.Installing;
    const isDownloading = phase === UpdatePhase.Downloading;

    const formatBytes = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <BaseDialog
            className="nx_UpdateDialog"
            hasCancel={isError}
            onFinished={onFinished}
            fixedWidth={false}
            title=""
        >
            <div className="nx_UpdateDialog_content">
                <img
                    src="res/img/nexus-logo.png"
                    alt="Nexus"
                    className="nx_UpdateDialog_logo"
                />

                {isError ? (
                    <>
                        <div className="nx_UpdateDialog_status">アップデートに失敗しました</div>
                        <div className="nx_UpdateDialog_sub">後でもう一度お試しください</div>
                    </>
                ) : isInstalling ? (
                    <>
                        <div className="nx_UpdateDialog_status">インストール中...</div>
                        <div className="nx_UpdateDialog_sub">自動で再起動します</div>
                        <div className="nx_UpdateDialog_progressBar">
                            <div
                                className="nx_UpdateDialog_progressFill nx_UpdateDialog_progressFill--indeterminate"
                            />
                        </div>
                    </>
                ) : isDownloading ? (
                    <>
                        <div className="nx_UpdateDialog_status">アップデートをダウンロード中...</div>
                        <div className="nx_UpdateDialog_sub">
                            {totalBytes > 0
                                ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
                                : "ダウンロード中..."}
                        </div>
                        <div className="nx_UpdateDialog_progressBar">
                            <div
                                className="nx_UpdateDialog_progressFill"
                                style={{ width: totalBytes > 0 ? `${percent}%` : "0%" }}
                            />
                        </div>
                        <div className="nx_UpdateDialog_hint">自動で再起動します</div>
                    </>
                ) : (
                    <>
                        <div className="nx_UpdateDialog_status">アップデートを準備中...</div>
                        <div className="nx_UpdateDialog_progressBar">
                            <div className="nx_UpdateDialog_progressFill nx_UpdateDialog_progressFill--indeterminate" />
                        </div>
                    </>
                )}
            </div>
        </BaseDialog>
    );
}
