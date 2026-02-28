/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useRef, useState } from "react";
import { IconPhoneOff, IconScreenShare, IconScreenShareOff } from "@tabler/icons-react";

import { type Call, ConnectionState } from "../../../../models/Call";
import type { NexusVoiceConnection } from "../../../../models/NexusVoiceConnection";
import { useConnectionState, useParticipatingMembers } from "../../../../hooks/useCall";
import { useNexusVoice } from "../../../../hooks/useNexusVoice";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import { NexusVoiceStore } from "../../../../stores/NexusVoiceStore";
import AccessibleButton from "../../elements/AccessibleButton";
import { NexusScreenSharePanel } from "../../voip/NexusScreenSharePanel";

interface NexusCallStatusPanelProps {
    call: Call | NexusVoiceConnection;
}

const statusLabels: Record<ConnectionState, string> = {
    [ConnectionState.Connecting]: "接続中…",
    [ConnectionState.Connected]: "通話中",
    [ConnectionState.Disconnecting]: "切断中…",
    [ConnectionState.Disconnected]: "切断済み",
};

const NexusCallStatusPanel: React.FC<NexusCallStatusPanelProps> = ({ call }) => {
    const connectionState = useConnectionState(call);
    const members = useParticipatingMembers(call);
    const { latencyMs, isScreenSharing } = useNexusVoice();
    const client = useMatrixClientContext();
    const room = client.getRoom(call.roomId);
    const roomName = room?.name ?? call.roomId;
    const [showSharePanel, setShowSharePanel] = useState(false);
    const shareButtonRef = useRef<HTMLButtonElement>(null);

    // Show "接続中…" until local user appears in participant list
    const myUserId = client.getUserId();
    const selfInList = members.some((m) => m.userId === myUserId);
    const displayState =
        connectionState === ConnectionState.Connected && !selfInList
            ? ConnectionState.Connecting
            : connectionState;

    const onDisconnect = useCallback(async () => {
        try {
            // Use NexusVoiceStore for voice connections to ensure proper cleanup
            const voiceConn = NexusVoiceStore.instance.getConnection(call.roomId);
            if (voiceConn) {
                await NexusVoiceStore.instance.leaveVoiceChannel();
            } else {
                await call.disconnect();
            }
        } catch {
            // Already disconnected — ignore
        }
    }, [call]);

    const onToggleScreenShare = useCallback(async () => {
        if (isScreenSharing) {
            const voiceConn = NexusVoiceStore.instance.getConnection(call.roomId);
            if (voiceConn) {
                await voiceConn.stopScreenShare();
            }
        } else {
            setShowSharePanel((prev) => !prev);
        }
    }, [call, isScreenSharing]);

    let dotClass: string;
    if (displayState === ConnectionState.Connected) {
        dotClass = "mx_NexusCallStatusPanel_dot--connected";
    } else if (displayState === ConnectionState.Connecting) {
        dotClass = "mx_NexusCallStatusPanel_dot--connecting";
    } else {
        dotClass = "mx_NexusCallStatusPanel_dot--disconnecting";
    }

    const latencyLabel =
        latencyMs !== null ? ` — ${latencyMs}ms` : "";

    return (
        <div className="mx_NexusCallStatusPanel">
            <div className="mx_NexusCallStatusPanel_info">
                <div className="mx_NexusCallStatusPanel_status">
                    <span className={`mx_NexusCallStatusPanel_dot ${dotClass}`} />
                    <span className={`mx_NexusCallStatusPanel_statusText${displayState === ConnectionState.Connecting ? " mx_NexusCallStatusPanel_statusText--connecting" : ""}`}>
                        {statusLabels[displayState]}{latencyLabel}
                    </span>
                </div>
                <span className="mx_NexusCallStatusPanel_roomName">{roomName}</span>
            </div>
            <AccessibleButton
                className={`mx_NexusCallStatusPanel_screenShareButton${isScreenSharing ? " mx_NexusCallStatusPanel_screenShareButton--active" : ""}`}
                element="button"
                onClick={onToggleScreenShare}
                ref={shareButtonRef}
                title={isScreenSharing ? "画面共有を停止" : "画面を共有"}
            >
                {isScreenSharing ? <IconScreenShareOff size={20} /> : <IconScreenShare size={20} />}
            </AccessibleButton>
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
            <AccessibleButton
                className="mx_NexusCallStatusPanel_disconnectButton"
                onClick={onDisconnect}
                title="通話を終了"
            >
                <IconPhoneOff size={20} />
            </AccessibleButton>
        </div>
    );
};

export default NexusCallStatusPanel;
