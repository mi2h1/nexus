/*
Copyright 2019-2024 New Vector Ltd.
Copyright 2019 The Matrix.org Foundation C.I.C.
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useCallback, useContext, useEffect, useState } from "react";
import { HTTPError } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { UserFriendlyError, _t } from "../../../../../languageHandler";
import UserProfileSettings from "../../UserProfileSettings";
import SettingsStore from "../../../../../settings/SettingsStore";
import AccessibleButton from "../../../elements/AccessibleButton";
import DeactivateAccountDialog from "../../../dialogs/DeactivateAccountDialog";
import Modal from "../../../../../Modal";
import { UIFeature } from "../../../../../settings/UIFeature";
import ErrorDialog, { extractErrorMessageFromError } from "../../../dialogs/ErrorDialog";
import ChangePassword from "../../ChangePassword";
import SettingsTab from "../SettingsTab";
import { SettingsSection } from "../../shared/SettingsSection";
import { SettingsSubsection, SettingsSubsectionText } from "../../shared/SettingsSubsection";
import { SDKContext } from "../../../../../contexts/SDKContext";
import { UserPersonalInfoSettings } from "../../UserPersonalInfoSettings";
import { useMatrixClientContext } from "../../../../../contexts/MatrixClientContext";
import { NexusUserColorStore, NexusUserColorStoreEvent } from "../../../../../stores/NexusUserColorStore";

interface IProps {
    closeSettingsFn: () => void;
}

interface AccountSectionProps {
    canChangePassword: boolean;
    onPasswordChangeError: (e: Error) => void;
    onPasswordChanged: () => void;
}

const AccountSection: React.FC<AccountSectionProps> = ({
    canChangePassword,
    onPasswordChangeError,
    onPasswordChanged,
}) => {
    if (!canChangePassword) return <></>;

    return (
        <>
            <SettingsSubsection
                heading={_t("settings|general|account_section")}
                stretchContent
                data-testid="accountSection"
            >
                <SettingsSubsectionText>{_t("settings|general|password_change_section")}</SettingsSubsectionText>
                <ChangePassword
                    rowClassName=""
                    buttonKind="primary"
                    onError={onPasswordChangeError}
                    onFinished={onPasswordChanged}
                />
            </SettingsSubsection>
        </>
    );
};

interface ManagementSectionProps {
    onDeactivateClicked: () => void;
}

const ManagementSection: React.FC<ManagementSectionProps> = ({ onDeactivateClicked }) => {
    return (
        <SettingsSection heading={_t("settings|general|deactivate_section")}>
            <SettingsSubsection
                heading={_t("settings|general|account_management_section")}
                data-testid="account-management-section"
                description={_t("settings|general|deactivate_warning")}
            >
                <AccessibleButton onClick={onDeactivateClicked} kind="danger">
                    {_t("settings|general|deactivate_section")}
                </AccessibleButton>
            </SettingsSubsection>
        </SettingsSection>
    );
};

const PRESET_COLORS = [
    "#e03131", "#f08c00", "#e8590c", "#ffd43b", "#2b8a3e",
    "#0ca678", "#1098ad", "#1c7ed6", "#4263eb", "#7048e8",
    "#ae3ec9", "#d6336c", "#f06595", "#ced4da", "#ff6b6b",
    "#20c997", "#339af0", "#845ef7", "#f783ac", "#fab005",
];

const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

const NexusUserColorPicker: React.FC = () => {
    const cli = useMatrixClientContext();
    const userId = cli.getSafeUserId();
    const displayName = cli.getUser(userId)?.displayName ?? userId;
    const store = NexusUserColorStore.instance;

    const [currentColor, setCurrentColor] = useState<string>(store.getColor(userId) ?? "");
    const [hexInput, setHexInput] = useState<string>(currentColor);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const onChanged = (): void => {
            const c = store.getColor(userId) ?? "";
            setCurrentColor(c);
            setHexInput(c);
        };
        store.on(NexusUserColorStoreEvent.ColorsChanged, onChanged);
        return () => {
            store.off(NexusUserColorStoreEvent.ColorsChanged, onChanged);
        };
    }, [store, userId]);

    const applyColor = useCallback(async (color: string) => {
        setSaving(true);
        try {
            await store.setMyColor(color);
        } catch (e) {
            logger.error("Failed to set user color", e);
        } finally {
            setSaving(false);
        }
    }, [store]);

    const onPresetClick = useCallback((color: string) => {
        setHexInput(color);
        applyColor(color);
    }, [applyColor]);

    const onHexApply = useCallback(() => {
        if (HEX_REGEX.test(hexInput)) {
            applyColor(hexInput);
        }
    }, [hexInput, applyColor]);

    const onReset = useCallback(() => {
        setHexInput("");
        applyColor("");
    }, [applyColor]);

    const previewColor = HEX_REGEX.test(hexInput) ? hexInput : currentColor;

    return (
        <SettingsSubsection heading="ユーザーカラー" stretchContent>
            <div className="mx_NexusUserColorPicker">
                <div className="mx_NexusUserColorPicker_presets">
                    {PRESET_COLORS.map((color) => (
                        <button
                            key={color}
                            type="button"
                            className={`mx_NexusUserColorPicker_preset${currentColor === color ? " mx_NexusUserColorPicker_preset--selected" : ""}`}
                            style={{ backgroundColor: color }}
                            onClick={() => onPresetClick(color)}
                            title={color}
                            disabled={saving}
                        />
                    ))}
                </div>

                <div className="mx_NexusUserColorPicker_hexRow">
                    <div
                        className="mx_NexusUserColorPicker_hexPreview"
                        style={{ backgroundColor: previewColor || undefined }}
                    />
                    <span>HEX:</span>
                    <input
                        type="text"
                        className="mx_NexusUserColorPicker_hexInput"
                        value={hexInput}
                        onChange={(e) => setHexInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") onHexApply(); }}
                        placeholder="#000000"
                        maxLength={7}
                        disabled={saving}
                    />
                    <AccessibleButton
                        kind="primary"
                        onClick={onHexApply}
                        disabled={saving || !HEX_REGEX.test(hexInput)}
                    >
                        適用
                    </AccessibleButton>
                </div>

                {previewColor && (
                    <div>
                        <span>プレビュー: </span>
                        <span className="mx_NexusUserColorPicker_preview" style={{ color: previewColor }}>
                            {displayName}
                        </span>
                    </div>
                )}

                <div className="mx_NexusUserColorPicker_actions">
                    <AccessibleButton kind="secondary" onClick={onReset} disabled={saving || !currentColor}>
                        デフォルトに戻す
                    </AccessibleButton>
                </div>

                <SettingsSubsectionText>
                    ユーザーカラーはこのサーバー専用です。他のサーバーでは適用されません。
                </SettingsSubsectionText>
            </div>
        </SettingsSubsection>
    );
};

const AccountUserSettingsTab: React.FC<IProps> = ({ closeSettingsFn }) => {
    const [externalAccountManagementUrl, setExternalAccountManagementUrl] = React.useState<string | undefined>();
    const [canMake3pidChanges, setCanMake3pidChanges] = React.useState<boolean>(false);
    const [canSetDisplayName, setCanSetDisplayName] = React.useState<boolean>(false);
    const [canSetAvatar, setCanSetAvatar] = React.useState<boolean>(false);
    const [canChangePassword, setCanChangePassword] = React.useState<boolean>(false);

    const cli = useMatrixClientContext();
    const sdkContext = useContext(SDKContext);

    useEffect(() => {
        (async () => {
            const capabilities = (await cli.getCapabilities()) ?? {};
            const changePasswordCap = capabilities["m.change_password"];

            // You can change your password so long as the capability isn't explicitly disabled. The implicit
            // behaviour is you can change your password when the capability is missing or has not-false as
            // the enabled flag value.
            const canChangePassword = !changePasswordCap || changePasswordCap["enabled"] !== false;

            await sdkContext.oidcClientStore.readyPromise; // wait for the store to be ready
            const externalAccountManagementUrl = sdkContext.oidcClientStore.accountManagementEndpoint;
            // https://spec.matrix.org/v1.7/client-server-api/#m3pid_changes-capability
            // We support as far back as v1.1 which doesn't have m.3pid_changes
            // so the behaviour for when it is missing has to be assume true
            const canMake3pidChanges =
                !capabilities["m.3pid_changes"] || capabilities["m.3pid_changes"].enabled === true;

            const canSetDisplayName =
                !capabilities["m.set_displayname"] || capabilities["m.set_displayname"].enabled === true;
            const canSetAvatar = !capabilities["m.set_avatar_url"] || capabilities["m.set_avatar_url"].enabled === true;

            setCanMake3pidChanges(canMake3pidChanges);
            setCanSetDisplayName(canSetDisplayName);
            setCanSetAvatar(canSetAvatar);
            setExternalAccountManagementUrl(externalAccountManagementUrl);
            setCanChangePassword(canChangePassword);
        })();
    }, [cli, sdkContext.oidcClientStore]);

    const onPasswordChangeError = useCallback((err: Error): void => {
        logger.error("Failed to change password: " + err);

        let underlyingError = err;
        if (err instanceof UserFriendlyError && err.cause instanceof Error) {
            underlyingError = err.cause;
        }

        const errorMessage = extractErrorMessageFromError(
            err,
            _t("settings|general|error_password_change_unknown", {
                stringifiedError: String(err),
            }),
        );

        let errorMessageToDisplay = errorMessage;
        if (underlyingError instanceof HTTPError && underlyingError.httpStatus === 403) {
            errorMessageToDisplay = _t("settings|general|error_password_change_403");
        } else if (underlyingError instanceof HTTPError) {
            errorMessageToDisplay = _t("settings|general|error_password_change_http", {
                errorMessage,
                httpStatus: underlyingError.httpStatus,
            });
        }

        // TODO: Figure out a design that doesn't involve replacing the current dialog
        Modal.createDialog(ErrorDialog, {
            title: _t("settings|general|error_password_change_title"),
            description: errorMessageToDisplay,
        });
    }, []);

    const onPasswordChanged = useCallback((): void => {
        const description = _t("settings|general|password_change_success");
        // TODO: Figure out a design that doesn't involve replacing the current dialog
        Modal.createDialog(ErrorDialog, {
            title: _t("common|success"),
            description,
        });
    }, []);

    const onDeactivateClicked = useCallback((): void => {
        const { finished } = Modal.createDialog(DeactivateAccountDialog);
        finished.then(([success]) => {
            if (success) closeSettingsFn();
        });
    }, [closeSettingsFn]);

    let accountManagementSection: JSX.Element | undefined;
    const isAccountManagedExternally = Boolean(externalAccountManagementUrl);
    if (SettingsStore.getValue(UIFeature.Deactivate) && !isAccountManagedExternally) {
        accountManagementSection = <ManagementSection onDeactivateClicked={onDeactivateClicked} />;
    }

    return (
        <SettingsTab data-testid="mx_AccountUserSettingsTab">
            <SettingsSection>
                <UserProfileSettings
                    externalAccountManagementUrl={externalAccountManagementUrl}
                    canSetDisplayName={canSetDisplayName}
                    canSetAvatar={canSetAvatar}
                />
                {(!isAccountManagedExternally || canMake3pidChanges) && (
                    <UserPersonalInfoSettings canMake3pidChanges={canMake3pidChanges} />
                )}
                <AccountSection
                    canChangePassword={canChangePassword}
                    onPasswordChanged={onPasswordChanged}
                    onPasswordChangeError={onPasswordChangeError}
                />
                <NexusUserColorPicker />
            </SettingsSection>
            {accountManagementSection}
        </SettingsTab>
    );
};

export default AccountUserSettingsTab;
