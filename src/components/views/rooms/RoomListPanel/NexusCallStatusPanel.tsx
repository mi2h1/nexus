/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback } from "react";
import { EndCallIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import { type Call, ConnectionState } from "../../../../models/Call";
import { useConnectionState } from "../../../../hooks/useCall";
import { useMatrixClientContext } from "../../../../contexts/MatrixClientContext";
import AccessibleButton from "../../elements/AccessibleButton";

interface NexusCallStatusPanelProps {
    call: Call;
}

const statusLabels: Record<ConnectionState, string> = {
    [ConnectionState.Connected]: "通話中",
    [ConnectionState.Disconnecting]: "切断中…",
    [ConnectionState.Disconnected]: "切断済み",
};

const NexusCallStatusPanel: React.FC<NexusCallStatusPanelProps> = ({ call }) => {
    const connectionState = useConnectionState(call);
    const client = useMatrixClientContext();
    const room = client.getRoom(call.roomId);
    const roomName = room?.name ?? call.roomId;

    const onDisconnect = useCallback(async () => {
        try {
            await call.disconnect();
        } catch {
            // Already disconnected — ignore
        }
    }, [call]);

    const dotClass =
        connectionState === ConnectionState.Connected
            ? "mx_NexusCallStatusPanel_dot--connected"
            : "mx_NexusCallStatusPanel_dot--disconnecting";

    return (
        <div className="mx_NexusCallStatusPanel">
            <div className="mx_NexusCallStatusPanel_info">
                <div className="mx_NexusCallStatusPanel_status">
                    <span className={`mx_NexusCallStatusPanel_dot ${dotClass}`} />
                    <span className="mx_NexusCallStatusPanel_statusText">{statusLabels[connectionState]}</span>
                </div>
                <span className="mx_NexusCallStatusPanel_roomName">{roomName}</span>
            </div>
            <AccessibleButton
                className="mx_NexusCallStatusPanel_disconnectButton"
                onClick={onDisconnect}
                title="通話を終了"
            >
                <EndCallIcon width={20} height={20} />
            </AccessibleButton>
        </div>
    );
};

export default NexusCallStatusPanel;
