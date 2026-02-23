/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useRef, useState } from "react";
import {
    MicOnSolidIcon,
    MicOffSolidIcon,
    SettingsSolidIcon,
    LeaveIcon,
    NotificationsSolidIcon,
    LockSolidIcon,
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
import IconizedContextMenu, {
    IconizedContextMenuOption,
    IconizedContextMenuOptionList,
} from "../../context_menus/IconizedContextMenu";
import { ChevronFace } from "../../../structures/ContextMenu";
import { _t } from "../../../../languageHandler";
import { UserTab } from "../../dialogs/UserTab";
import { type OpenToTabPayload } from "../../../../dispatcher/payloads/OpenToTabPayload";
import Modal from "../../../../Modal";
import LogoutDialog, { shouldShowLogoutDialog } from "../../dialogs/LogoutDialog";

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

    // Context menu state
    const avatarRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);

    const onToggleMic = useCallback(() => {
        if (!call) return;

        if (call instanceof NexusVoiceConnection) {
            call.setMicMuted(!call.isMicMuted);
        }
    }, [call]);

    const onAvatarClick = useCallback(() => {
        setMenuOpen((prev) => !prev);
    }, []);

    const closeMenu = useCallback(() => {
        setMenuOpen(false);
    }, []);

    const onSettingsOpen = useCallback((tabId?: string) => {
        const payload: OpenToTabPayload = { action: Action.ViewUserSettings, initialTabId: tabId };
        defaultDispatcher.dispatch(payload);
        closeMenu();
    }, [closeMenu]);

    const onSignOutClick = useCallback(async () => {
        if (await shouldShowLogoutDialog(MatrixClientPeg.safeGet())) {
            Modal.createDialog(LogoutDialog);
        } else {
            defaultDispatcher.dispatch({ action: "logout" });
        }
        closeMenu();
    }, [closeMenu]);

    // Context menu positioning — above the avatar (opens upward)
    const renderContextMenu = (): React.ReactNode => {
        if (!menuOpen || !avatarRef.current) return null;

        const rect = avatarRef.current.getBoundingClientRect();

        return (
            <IconizedContextMenu
                left={rect.left}
                top={rect.top - 8}
                chevronFace={ChevronFace.None}
                onFinished={closeMenu}
                className="mx_UserMenu_contextMenu"
                compact
                {...{ "bottom-aligned": true } as any}
            >
                <div className="mx_UserMenu_contextMenu_header">
                    <div className="mx_UserMenu_contextMenu_name">
                        <span className="mx_UserMenu_contextMenu_displayName">
                            {displayName ?? userId}
                        </span>
                        <span className="mx_UserMenu_contextMenu_userId">
                            {userId}
                        </span>
                    </div>
                </div>
                <IconizedContextMenuOptionList>
                    <IconizedContextMenuOption
                        icon={<NotificationsSolidIcon />}
                        label={_t("notifications|enable_prompt_toast_title")}
                        onClick={() => onSettingsOpen(UserTab.Notifications)}
                    />
                    <IconizedContextMenuOption
                        icon={<LockSolidIcon />}
                        label={_t("room_settings|security|title")}
                        onClick={() => onSettingsOpen(UserTab.Security)}
                    />
                    <IconizedContextMenuOption
                        icon={<SettingsSolidIcon />}
                        label={_t("user_menu|settings")}
                        onClick={() => onSettingsOpen()}
                    />
                    <IconizedContextMenuOption
                        className="mx_IconizedContextMenu_option_red"
                        icon={<LeaveIcon />}
                        label={_t("action|sign_out")}
                        onClick={onSignOutClick}
                    />
                </IconizedContextMenuOptionList>
            </IconizedContextMenu>
        );
    };

    return (
        <div className="mx_NexusUserPanel">
            {call && isConnected && <NexusCallStatusPanel call={call} />}
            <div className="mx_NexusUserPanel_content">
                <div className="mx_NexusUserPanel_profile" ref={avatarRef}>
                    <AccessibleButton
                        className="mx_NexusUserPanel_avatarButton"
                        onClick={onAvatarClick}
                        title={_t("a11y|user_menu")}
                    >
                        <BaseAvatar
                            idName={userId}
                            name={displayName ?? userId}
                            url={avatarUrl}
                            size="32px"
                        />
                    </AccessibleButton>
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
                        onClick={() => onSettingsOpen()}
                        title="設定"
                    >
                        <SettingsSolidIcon width={20} height={20} />
                    </AccessibleButton>
                </div>
            </div>
            {renderContextMenu()}
        </div>
    );
};

export default NexusUserPanel;
