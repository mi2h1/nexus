/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useState } from "react";
import {
    MicOnSolidIcon,
    MicOffSolidIcon,
    SettingsSolidIcon,
} from "@vector-im/compound-design-tokens/assets/web/icons";

import { useActiveCall } from "../../../../hooks/useActiveCall";
import { useConnectionState } from "../../../../hooks/useCall";
import { ConnectionState } from "../../../../models/Call";
import { OwnProfileStore } from "../../../../stores/OwnProfileStore";
import { MatrixClientPeg } from "../../../../MatrixClientPeg";
import { UPDATE_EVENT } from "../../../../stores/AsyncStore";
import { useEventEmitterState } from "../../../../hooks/useEventEmitter";
import BaseAvatar from "../../avatars/BaseAvatar";
import AccessibleButton from "../../elements/AccessibleButton";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { Action } from "../../../../dispatcher/actions";
import { ElementWidgetActions } from "../../../../stores/widgets/ElementWidgetActions";
import WidgetUtils from "../../../../utils/WidgetUtils";
import { WidgetMessagingStore } from "../../../../stores/widgets/WidgetMessagingStore";
import NexusCallStatusPanel from "./NexusCallStatusPanel";

const NexusUserPanel: React.FC = () => {
    const call = useActiveCall();
    const connectionState = useConnectionState(call);
    const isConnected = connectionState === ConnectionState.Connected;

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

    // Mic mute state
    const [isMicMuted, setIsMicMuted] = useState(false);

    const onToggleMic = useCallback(async () => {
        if (!call) return;
        const uid = WidgetUtils.getWidgetUid(call.widget);
        const messaging = WidgetMessagingStore.instance.getMessagingForUid(uid);
        if (!messaging?.widgetApi) return;

        const newMuted = !isMicMuted;
        setIsMicMuted(newMuted);
        try {
            await messaging.widgetApi.transport.send(ElementWidgetActions.DeviceMute, {
                audio_enabled: !newMuted,
            });
        } catch {
            // Widget may not support DeviceMute — revert state
            setIsMicMuted(!newMuted);
        }
    }, [call, isMicMuted]);

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
