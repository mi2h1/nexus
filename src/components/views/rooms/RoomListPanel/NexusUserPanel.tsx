/*
Copyright 2025 Nexus Contributors

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Settings, LogOut, Bell, Lock, Download } from "lucide-react";

import { useActiveCall } from "../../../../hooks/useActiveCall";
import { useConnectionState } from "../../../../hooks/useCall";
import { ConnectionState } from "../../../../models/Call";
import { useNexusVoice } from "../../../../hooks/useNexusVoice";
import { NexusVoiceStore, NexusVoiceStoreEvent } from "../../../../stores/NexusVoiceStore";
import { OwnProfileStore } from "../../../../stores/OwnProfileStore";
import { MatrixClientPeg } from "../../../../MatrixClientPeg";
import { UPDATE_EVENT } from "../../../../stores/AsyncStore";
import { useEventEmitterState } from "../../../../hooks/useEventEmitter";
import BaseAvatar from "../../avatars/BaseAvatar";
import AccessibleButton from "../../elements/AccessibleButton";
import defaultDispatcher from "../../../../dispatcher/dispatcher";
import { Action } from "../../../../dispatcher/actions";
import NexusCallStatusPanel from "./NexusCallStatusPanel";
import { NexusUpdateStore, NexusUpdateStoreEvent } from "../../../../stores/NexusUpdateStore";
import PlatformPeg from "../../../../PlatformPeg";
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
import NexusUpdateDialog from "../../dialogs/NexusUpdateDialog";

const NexusUserPanel: React.FC = () => {
    const call = useActiveCall();
    const connectionState = useConnectionState(call);
    const isInCall =
        connectionState === ConnectionState.Connected ||
        connectionState === ConnectionState.Connecting;
    const { isMicMuted } = useNexusVoice();

    // Pre-mute state (when not in a VC)
    const preMicMuted = useEventEmitterState(
        NexusVoiceStore.instance,
        NexusVoiceStoreEvent.PreMicMuted,
        useCallback(() => NexusVoiceStore.instance.preMicMuted, []),
    );

    // Show muted if in VC and muted, or if not in VC and pre-muted.
    // During Connecting phase, continue showing preMicMuted because the
    // connection's isMicMuted hasn't been initialized from preMicMuted yet.
    const effectiveMuted =
        connectionState === ConnectionState.Connected ? isMicMuted : preMicMuted;

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

    // Update availability
    const updateAvailable = useEventEmitterState(
        NexusUpdateStore.instance,
        NexusUpdateStoreEvent.UpdateAvailable,
        useCallback(() => NexusUpdateStore.instance.updateAvailable, []),
    );
    const [showUpdateTooltip, setShowUpdateTooltip] = useState(false);

    // Auto-show tooltip for a few seconds when update becomes available
    useEffect(() => {
        if (!updateAvailable) return;
        setShowUpdateTooltip(true);
        const timer = setTimeout(() => setShowUpdateTooltip(false), 5000);
        return () => clearTimeout(timer);
    }, [updateAvailable]);

    const onUpdateClick = useCallback(() => {
        Modal.createDialog(NexusUpdateDialog, {}, "nx_UpdateDialog");
        PlatformPeg.get()?.installUpdate();
    }, []);

    // Context menu state
    const avatarRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);

    const onToggleMic = useCallback(() => {
        NexusVoiceStore.instance.toggleMic();
    }, []);

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
                        icon={<Bell size={20} />}
                        label={_t("notifications|enable_prompt_toast_title")}
                        onClick={() => onSettingsOpen(UserTab.Notifications)}
                    />
                    <IconizedContextMenuOption
                        icon={<Lock size={20} />}
                        label={_t("room_settings|security|title")}
                        onClick={() => onSettingsOpen(UserTab.Security)}
                    />
                    <IconizedContextMenuOption
                        icon={<Settings size={20} />}
                        label={_t("user_menu|settings")}
                        onClick={() => onSettingsOpen()}
                    />
                    <IconizedContextMenuOption
                        className="mx_IconizedContextMenu_option_red"
                        icon={<LogOut size={20} />}
                        label={_t("action|sign_out")}
                        onClick={onSignOutClick}
                    />
                </IconizedContextMenuOptionList>
            </IconizedContextMenu>
        );
    };

    return (
        <div className="mx_NexusUserPanel">
            <div className="mx_NexusUserPanel_content">
                {call && isInCall && (
                    <>
                        <NexusCallStatusPanel call={call} />
                        <div className="mx_NexusUserPanel_separator" />
                    </>
                )}
                <div className="mx_NexusUserPanel_row">
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
                    {updateAvailable && (
                        <div className="mx_NexusUserPanel_updateWrapper">
                            <AccessibleButton
                                className="mx_NexusUserPanel_button mx_NexusUserPanel_button--update"
                                onClick={onUpdateClick}
                                title="アップデートがあります"
                            >
                                <Download size={20} />
                            </AccessibleButton>
                            {showUpdateTooltip && (
                                <div className="mx_NexusUserPanel_updateTooltip">
                                    アップデートがあります
                                </div>
                            )}
                        </div>
                    )}
                    <AccessibleButton
                        className={`mx_NexusUserPanel_button ${effectiveMuted ? "mx_NexusUserPanel_button--muted" : ""}`}
                        onClick={onToggleMic}
                        title={effectiveMuted ? "マイクをオンにする" : "マイクをミュートする"}
                    >
                        {effectiveMuted ? (
                            <MicOff size={20} />
                        ) : (
                            <Mic size={20} />
                        )}
                    </AccessibleButton>
                    <AccessibleButton
                        className="mx_NexusUserPanel_button"
                        onClick={() => onSettingsOpen()}
                        title="設定"
                    >
                        <Settings size={20} />
                    </AccessibleButton>
                    </div>
                </div>
            </div>
            {renderContextMenu()}
        </div>
    );
};

export default NexusUserPanel;
