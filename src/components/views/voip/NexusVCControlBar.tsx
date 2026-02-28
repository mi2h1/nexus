/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useRef, useState, type JSX } from "react";
import classNames from "classnames";
import { Mic, MicOff, MonitorUp, MonitorCog, Settings, PhoneOff, ExternalLink, SquareArrowOutDownLeft, MonitorOff } from "lucide-react";

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
    /** Portal target for screen share panel/picker — set to popout body when in a child window. */
    portalContainer?: HTMLElement;
    layoutMode?: "spotlight" | "grid";
    focusMode?: boolean;
    onToggleFocusMode?: () => void;
    /** Stop watching the current spotlight screen share. Shown only when set. */
    onStopWatching?: () => void;
}

export function NexusVCControlBar({
    roomId,
    onPopout,
    onRestoreFromPopout,
    isPopout,
    portalContainer,
    layoutMode,
    focusMode,
    onToggleFocusMode,
    onStopWatching,
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
            {/* Focus mode only: 「メンバーを表示」positioned above the bar */}
            {layoutMode === "spotlight" && focusMode && onToggleFocusMode && (
                <button
                    className="nx_VCControlBar_focusToggle"
                    onClick={onToggleFocusMode}
                >
                    メンバーを表示
                </button>
            )}

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
                        <MicOff size={22} />
                    ) : (
                        <Mic size={22} />
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
                    {isScreenSharing ? <MonitorCog size={22} /> : <MonitorUp size={22} />}
                </AccessibleButton>

                {/* Settings */}
                <AccessibleButton
                    className="nx_VCControlBar_button"
                    onClick={onSettings}
                    title="設定"
                    disableTooltip={isPopout}
                >
                    <Settings size={22} />
                </AccessibleButton>

                {/* End call */}
                <AccessibleButton
                    className="nx_VCControlBar_button nx_VCControlBar_button--endCall"
                    onClick={onEndCall}
                    title="通話を終了"
                    disableTooltip={isPopout}
                >
                    <PhoneOff size={22} />
                </AccessibleButton>

                {/* Stop watching screen share */}
                {onStopWatching && (
                    <AccessibleButton
                        className="nx_VCControlBar_button nx_VCControlBar_button--stopWatching"
                        onClick={onStopWatching}
                        title="視聴を停止"
                        disableTooltip={isPopout}
                    >
                        <MonitorOff size={20} />
                    </AccessibleButton>
                )}

            </div>

            <div className="nx_VCControlBar_right">
                {onPopout && (
                    <AccessibleButton
                        className="nx_VCControlBar_layoutButton"
                        onClick={onPopout}
                        title="別ウィンドウで表示"
                    >
                        <ExternalLink size={20} />
                    </AccessibleButton>
                )}
                {onRestoreFromPopout && (
                    <AccessibleButton
                        className="nx_VCControlBar_layoutButton"
                        onClick={onRestoreFromPopout}
                        title="元に戻す"
                        disableTooltip={isPopout}
                    >
                        <SquareArrowOutDownLeft size={20} />
                    </AccessibleButton>
                )}
            </div>

            {showSharePanel && shareButtonRef.current && (() => {
                const rect = shareButtonRef.current!.getBoundingClientRect();
                const win = shareButtonRef.current!.ownerDocument.defaultView ?? window;
                return (
                    <NexusScreenSharePanel
                        isScreenSharing={isScreenSharing}
                        anchorLeft={rect.left + rect.width / 2}
                        anchorBottom={win.innerHeight - rect.top + 8}
                        onFinished={() => setShowSharePanel(false)}
                        portalContainer={portalContainer}
                    />
                );
            })()}
        </div>
    );
}
