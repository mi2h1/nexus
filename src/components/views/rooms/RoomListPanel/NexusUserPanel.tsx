/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback } from "react";
import {
    MicOnSolidIcon,
    MicOffSolidIcon,
    SettingsSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useActiveCall } from "../../../../hooks/useActiveCall";
import { useConnectionState } from "../../../../hooks/useCall";
import { ConnectionState } from "../../../../models/Call";
import { NexusVoiceConnection } from "../../../../models/NexusVoiceConnection";
import { useNexusVoice } from "../../../../hooks/useNexusVoice";
import { OwnProfileStore } from "../../../../stores/OwnProfileStore";
import { MatrixClientPeg } from "../../../../MatrixClientPeg";
import { UPDATE_EVENT } from "../../../../stores/AsyncStore";
import { useEventEmitterState } from "../../../../hooks/useEventEmitter";
import BaseAvatar from "../../avatars/BaseAvatar";
import AccessibleButton from "../../elements/AccessibleButton";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { Action } from "../../../../dispatcher/actions";
import NexusCallStatusPanel from "./NexusCallStatusPanel";

const NexusUserPanel: React.FC = () => {
    const call = useActiveCall();
    const connectionState = useConnectionState(call);
    const isConnected = connectionState === ConnectionState.Connected;
    const { isMicMuted } = useNexusVoice();

    // Profile info (reactive)
    const displayName = useEventEmitterState(OwnProfileStore.instance, UPDATE_EVENT, useCallback(
        () => OwnProfileStore.instance.displayName,
        [],
    ));
    const avatarUrl = useEventEmitterState(OwnProfileStore.instance, UPDATE_EVENT, useCallback(
        () => OwnProfileStore.instance.getHttpAvatarUrl(32),
        [],
    ));
    const userId = MatrixClientPeg.safeGet().getSafeUserId();

    const onToggleMic = useCallback(() => {
        if (!call) return;

        if (call instanceof NexusVoiceConnection) {
            // Direct mic control via NexusVoiceConnection
            call.setMicMuted(!call.isMicMuted);
        }
        // For legacy Call instances with widget API, mic control is not supported
        // from this panel (the iframe handles it).
    }, [call]);

    const onOpenSettings = useCallback(() => {
        defaultDispatcher.dispatch({ action: Action.ViewUserSettings });
    }, []);

    return (
        <div className="mx_NexusUserPanel">
            {call && isConnected && <NexusCallStatusPanel call={call} />}
            <div className="mx_NexusUserPanel_content">
                <div className="mx_NexusUserPanel_profile">
                    <BaseAvatar
                        idName={userId}
                        name={displayName ?? userId}
                        url={avatarUrl}
                        size="32px"
                    />
                    <span className="mx_NexusUserPanel_displayName">{displayName ?? userId}</span>
                </div>
                <div className="mx_NexusUserPanel_actions">
                    <AccessibleButton
                        className={`mx_NexusUserPanel_button ${isMicMuted ? "mx_NexusUserPanel_button--muted" : ""}`}
                        onClick={onToggleMic}
                        disabled={!isConnected}
                        title={isMicMuted ? "マイクをオンにする" : "マイクをミュートする"}
                    >
                        {isMicMuted ? (
                            <MicOffSolidIcon width={20} height={20} />
                        ) : (
                            <MicOnSolidIcon width={20} height={20} />
                        )}
                    </AccessibleButton>
                    <AccessibleButton
                        className="mx_NexusUserPanel_button"
                        onClick={onOpenSettings}
                        title="設定"
                    >
                        <SettingsSolidIcon width={20} height={20} />
                    </AccessibleButton>
                </div>
            </div>
        </div>
    );
};

export default NexusUserPanel;
