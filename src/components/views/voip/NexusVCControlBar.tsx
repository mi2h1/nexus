/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useRef, useState, type JSX } from "react";
import classNames from "classnames";
import {
    MicOnSolidIcon,
    MicOffSolidIcon,
    ShareScreenSolidIcon,
    SettingsSolidIcon,
    EndCallIcon,
    PopOutIcon,
    CollapseIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useNexusVoice } from "../../../hooks/useNexusVoice";
import { NexusVoiceStore } from "../../../stores/NexusVoiceStore";
import dis from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { type OpenToTabPayload } from "../../../dispatcher/payloads/OpenToTabPayload";
import { UserTab } from "../../views/dialogs/UserTab";
import AccessibleButton from "../elements/AccessibleButton";
import { NexusScreenSharePanel } from "./NexusScreenSharePanel";
import { isTauri } from "../../../utils/tauriHttp";

interface NexusVCControlBarProps {
    roomId: string;
    onPopout?: () => void;
    /** Callback to restore the popout window back into the main window. */
    onRestoreFromPopout?: () => void;
    /** When true, disables Compound tooltips (FloatingPortal targets the wrong document in popout windows). */
    isPopout?: boolean;
}

export function NexusVCControlBar({
    roomId,
    onPopout,
    onRestoreFromPopout,
    isPopout,
}: NexusVCControlBarProps): JSX.Element {
    const { isMicMuted, isScreenSharing } = useNexusVoice();
    const [showSharePanel, setShowSharePanel] = useState(false);
    const shareButtonRef = useRef<HTMLButtonElement>(null);

    const onToggleMic = useCallback(() => {
        NexusVoiceStore.instance.toggleMic();
    }, []);

    const onScreenShareClick = useCallback(() => {
        if (isScreenSharing && !isTauri()) {
            // Browser: stop immediately without opening the panel
            const conn = NexusVoiceStore.instance.getActiveConnection();
            conn?.stopScreenShare();
        } else {
            // Not sharing: open panel / Tauri + sharing: open picker in switch mode
            setShowSharePanel((prev) => !prev);
        }
    }, [isScreenSharing]);

    const onEndCall = useCallback(() => {
        NexusVoiceStore.instance.leaveVoiceChannel();
    }, []);

    const onSettings = useCallback(() => {
        dis.dispatch<OpenToTabPayload>({
            action: Action.ViewUserSettings,
            initialTabId: UserTab.Voice,
        });
    }, []);

    return (
        <div className="nx_VCControlBar">
            <div className="nx_VCControlBar_center">
                {/* Mic toggle */}
                <AccessibleButton
                    className={classNames("nx_VCControlBar_button", {
                        "nx_VCControlBar_button--micMuted": isMicMuted,
                    })}
                    onClick={onToggleMic}
                    title={isMicMuted ? "マイクをオンにする" : "マイクをミュートする"}
                    disableTooltip={isPopout}
                >
                    {isMicMuted ? (
                        <MicOffSolidIcon width={22} height={22} />
                    ) : (
                        <MicOnSolidIcon width={22} height={22} />
                    )}
                </AccessibleButton>

                {/* Screen share */}
                <AccessibleButton
                    className={classNames("nx_VCControlBar_button", {
                        "nx_VCControlBar_button--screenSharing": isScreenSharing,
                    })}
                    element="button"
                    onClick={onScreenShareClick}
                    ref={shareButtonRef}
                    title={isScreenSharing ? (isTauri() ? "配信設定" : "共有を停止") : "画面を共有"}
                    disableTooltip={isPopout}
                >
                    <ShareScreenSolidIcon width={22} height={22} />
                </AccessibleButton>

                {/* Settings */}
                <AccessibleButton
                    className="nx_VCControlBar_button"
                    onClick={onSettings}
                    title="設定"
                    disableTooltip={isPopout}
                >
                    <SettingsSolidIcon width={22} height={22} />
                </AccessibleButton>

                {/* End call */}
                <AccessibleButton
                    className="nx_VCControlBar_button nx_VCControlBar_button--endCall"
                    onClick={onEndCall}
                    title="通話を終了"
                    disableTooltip={isPopout}
                >
                    <EndCallIcon width={22} height={22} />
                </AccessibleButton>

            </div>

            <div className="nx_VCControlBar_right">
                {onPopout && (
                    <AccessibleButton
                        className="nx_VCControlBar_layoutButton"
                        onClick={onPopout}
                        title="別ウィンドウで表示"
                    >
                        <PopOutIcon width={20} height={20} />
                    </AccessibleButton>
                )}
                {onRestoreFromPopout && (
                    <AccessibleButton
                        className="nx_VCControlBar_layoutButton"
                        onClick={onRestoreFromPopout}
                        title="元に戻す"
                        disableTooltip={isPopout}
                    >
                        <CollapseIcon width={20} height={20} />
                    </AccessibleButton>
                )}
            </div>

            {showSharePanel && shareButtonRef.current && (() => {
                const rect = shareButtonRef.current!.getBoundingClientRect();
                return (
                    <NexusScreenSharePanel
                        isScreenSharing={isScreenSharing}
                        anchorLeft={rect.left + rect.width / 2}
                        anchorBottom={window.innerHeight - rect.top + 8}
                        onFinished={() => setShowSharePanel(false)}
                    />
                );
            })()}
        </div>
    );
}
